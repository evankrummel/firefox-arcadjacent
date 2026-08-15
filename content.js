document.addEventListener("keydown", (e) => {
  // Check for Cmd + W on Mac
  if (e.metaKey && e.key.toLowerCase() === "w") {
    // Send a message to the background script
    browser.runtime.sendMessage({ action: "cmd_w_pressed" });
  }
});
