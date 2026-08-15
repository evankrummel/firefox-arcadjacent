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
