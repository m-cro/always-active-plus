const labName = document.body.dataset.labName;
chrome.tabs.getCurrent(tab => {
  if (!tab?.id || !labName) return;
  const tabKey = String(tab.id);
  chrome.storage.local.get({testLabTabs: {}}, prefs => {
    chrome.storage.local.set({
      testLabTabs: {...prefs.testLabTabs, [tabKey]: labName}
    });
  });

  const forgetLabTab = () => chrome.storage.local.get({testLabTabs: {}}, prefs => {
    const testLabTabs = {...prefs.testLabTabs};
    delete testLabTabs[tabKey];
    chrome.storage.local.set({testLabTabs});
  });
  window.addEventListener('pagehide', forgetLabTab, {once: true, capture: true});
  window.addEventListener('beforeunload', forgetLabTab, {once: true});
});
