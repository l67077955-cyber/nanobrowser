import { useEffect, useState } from 'react';
import { FiExternalLink } from 'react-icons/fi';
import { t } from '@extension/i18n';

/** Moves Nanobrowser from the side panel into a window of its own. Not shown in that window. */
export default function OpenInWindowButton() {
  const [isDocked, setIsDocked] = useState(false);

  useEffect(() => {
    // a side panel is not a tab
    chrome.tabs
      .getCurrent()
      .then(tab => setIsDocked(!tab))
      .catch(err => console.error('Failed to tell where the panel is open:', err));
  }, []);

  if (!isDocked) return null;

  const handleClick = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'open_standalone_window' });
      window.close();
    } catch (err) {
      console.error('Failed to open the separate window:', err);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="header-icon"
      aria-label={t('nav_openInWindow_a11y')}
      title={t('nav_openInWindow_a11y')}>
      <FiExternalLink size={17} />
    </button>
  );
}
