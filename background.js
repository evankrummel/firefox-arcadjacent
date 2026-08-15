browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // If the user is closing the entire browser window, do nothing.
  if (removeInfo.isWindowClosing) {
    return;
  }

  // Fetch all tabs that are currently open in that specific window.
  const remainingTabs = await browser.tabs.query({ windowId: removeInfo.windowId });

  // Check if at least one unpinned tab still exists.
  const hasUnpinnedTabs = remainingTabs.some(tab => !tab.pinned);

  // If there are no unpinned tabs left, create a new one.
  if (!hasUnpinnedTabs) {
    browser.tabs.create({ 
      windowId: removeInfo.windowId,
      active: true 
    });
  }
});

// Store the core URLs in memory. Key: tabId, Value: rootUrl
const pinnedRoots = new Map();

// 1. Capture core URLs of any already-pinned tabs when Firefox starts
// We now read from persistent tab sessions so it survives browser restarts!
browser.tabs.query({ pinned: true }).then(async (tabs) => {
  for (const tab of tabs) {
    let coreUrl = await browser.sessions.getTabValue(tab.id, "coreUrl");
    if (coreUrl) {
      pinnedRoots.set(tab.id, coreUrl);
    } else {
      // If none existed, set it now
      await browser.sessions.setTabValue(tab.id, "coreUrl", tab.url);
      pinnedRoots.set(tab.id, tab.url);
    }
    // Start inactivity timer for inactive pinned tabs on startup
    if (!tab.active) {
      browser.alarms.create(`reset-${tab.id}`, { delayInMinutes: 3 * 60 });
    }
  }
});

// 2. Add "Reset" option to the Tab right-click menu
browser.menus.create({
  id: "reset-pinned-tab",
  title: "Reset to Core Page",
  contexts: ["tab"] // This ensures it only shows up when right-clicking a tab
});

// Listen for Context Menu clicks
browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "reset-pinned-tab" && tab.pinned) {
    resetTab(tab.id);
  }
});

// 3. Listen for the Keyboard Shortcut
browser.commands.onCommand.addListener(async (command) => {
  if (command === "reset-pinned-tab") {
    // Get the tab you are currently looking at
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].pinned) {
      resetTab(tabs[0].id);
    }
  }
});

// 4. Watch for tabs being pinned/unpinned in real-time
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.pinned === true) {
    // Only set if we haven't already (in case it's a restored tab or existing)
    let coreUrl = await browser.sessions.getTabValue(tabId, "coreUrl");
    if (!coreUrl) {
      coreUrl = tab.url;
      await browser.sessions.setTabValue(tabId, "coreUrl", coreUrl);
    }
    pinnedRoots.set(tabId, coreUrl);
    if (!tab.active) {
      browser.alarms.create(`reset-${tabId}`, { delayInMinutes: 3 * 60 });
    }
  } else if (changeInfo.pinned === false) {
    // Tab was unpinned, forget its core URL completely
    await browser.sessions.removeTabValue(tabId, "coreUrl");
    pinnedRoots.delete(tabId);
    browser.alarms.clear(`reset-${tabId}`);
  }
});

// When a pinned tab is closed (e.g. via Cmd+W), recreate it immediately at its core URL
browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (removeInfo.isWindowClosing) {
    return;
  }

  const coreUrl = pinnedRoots.get(tabId);
  // Delete the old tabId from memory
  pinnedRoots.delete(tabId);
  browser.alarms.clear(`reset-${tabId}`);

  if (coreUrl) {
    // Recreate the pinned tab in the background so it feels like it just "reset"
    const newTab = await browser.tabs.create({
      windowId: removeInfo.windowId,
      url: coreUrl,
      pinned: true,
      active: false
    });
    // Explicitly memorize the newly created tab's core URL persistently
    await browser.sessions.setTabValue(newTab.id, "coreUrl", coreUrl);
    pinnedRoots.set(newTab.id, coreUrl);
  }
});

// Helper function to navigate the tab back to its root
async function resetTab(tabId) {
  const coreUrl = pinnedRoots.get(tabId);
  if (coreUrl) {
    try {
      const tab = await browser.tabs.get(tabId);
      // Only trigger a reset (which causes a page load) if it actually navigated away
      if (tab.url !== coreUrl) {
        browser.tabs.update(tabId, { url: coreUrl });
      }
    } catch (e) {}
  }
}

// 5. Listen for the Cmd+W shortcut from our content script
browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.action === "cmd_w_pressed" && sender.tab && sender.tab.pinned) {
    const coreUrl = pinnedRoots.get(sender.tab.id);
    if (coreUrl) {
      // Find the next available tab to switch focus to
      const allTabs = await browser.tabs.query({ currentWindow: true });
      const currentIndex = sender.tab.index;
      
      // Try to find the next unpinned tab, or just the next tab
      let nextTab = allTabs.find(t => t.index > currentIndex && !t.pinned) 
                 || allTabs.find(t => t.index > currentIndex) 
                 || allTabs[0];

      if (nextTab && nextTab.id !== sender.tab.id) {
        await browser.tabs.update(nextTab.id, { active: true });
      }

      // Reset the pinned tab back to its core URL silently in the background
      await browser.tabs.update(sender.tab.id, { url: coreUrl });
    }
  }
});

// 6. Automatically reset pinned tabs after 3 hours of inactivity
const activeTabs = new Map();

browser.tabs.query({ active: true }).then(tabs => {
  for (const tab of tabs) {
    activeTabs.set(tab.windowId, tab.id);
  }
});

browser.tabs.onActivated.addListener(async (activeInfo) => {
  const previousTabId = activeTabs.get(activeInfo.windowId);
  activeTabs.set(activeInfo.windowId, activeInfo.tabId);

  // Clear alarm for newly active tab
  browser.alarms.clear(`reset-${activeInfo.tabId}`);

  if (previousTabId) {
    try {
      const prevTab = await browser.tabs.get(previousTabId);
      if (prevTab.pinned) {
        // The pinned tab lost focus. Start the 3-hour inactivity timer.
        browser.alarms.create(`reset-${prevTab.id}`, { delayInMinutes: 3 * 60 });
      }
    } catch (e) { }
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith("reset-")) {
    const tabId = parseInt(alarm.name.replace("reset-", ""), 10);
    try {
      const tab = await browser.tabs.get(tabId);
      // Reset only if it's still pinned and not active
      if (tab.pinned && !tab.active) {
        resetTab(tabId);
      }
    } catch(e) {}
  }
});
