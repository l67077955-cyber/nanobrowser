import { useState } from 'react';
import '@src/Options.css';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { t } from '@extension/i18n';
import { FiSettings, FiCpu, FiShield, FiTrendingUp, FiHelpCircle } from 'react-icons/fi';
import { GeneralSettings } from './components/GeneralSettings';
import { ModelSettings } from './components/ModelSettings';
import { FirewallSettings } from './components/FirewallSettings';
import { AnalyticsSettings } from './components/AnalyticsSettings';

type TabTypes = 'general' | 'models' | 'firewall' | 'analytics' | 'help';

const TABS: { id: TabTypes; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { id: 'general', icon: FiSettings, label: t('options_tabs_general') },
  { id: 'models', icon: FiCpu, label: t('options_tabs_models') },
  { id: 'firewall', icon: FiShield, label: t('options_tabs_firewall') },
  { id: 'analytics', icon: FiTrendingUp, label: 'Analytics' },
  { id: 'help', icon: FiHelpCircle, label: t('options_tabs_help') },
];

const Options = () => {
  const [activeTab, setActiveTab] = useState<TabTypes>('models');

  const handleTabClick = (tabId: TabTypes) => {
    if (tabId === 'help') {
      window.open('https://nanobrowser.ai/docs', '_blank');
    } else {
      setActiveTab(tabId);
    }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return <GeneralSettings />;
      case 'models':
        return <ModelSettings />;
      case 'firewall':
        return <FirewallSettings />;
      case 'analytics':
        return <AnalyticsSettings />;
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-screen min-w-[768px] bg-nb-page text-nb-ink">
      {/* Vertical Navigation Bar */}
      <nav className="w-52 shrink-0 border-r border-nb-line">
        <div className="sticky top-0 p-4">
          <div className="mb-5 flex items-center gap-2 px-2">
            <img src="/icon-128.png" alt="" className="size-6" />
            <h1 className="text-base font-semibold tracking-tight">{t('options_nav_header')}</h1>
          </div>
          <ul className="space-y-1">
            {TABS.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => handleTabClick(item.id)}
                  aria-current={activeTab === item.id ? 'page' : undefined}
                  className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-llm ${
                    activeTab === item.id
                      ? 'border-nb-line bg-nb-tile font-medium text-nb-ink shadow-nb'
                      : 'border-transparent text-nb-ink-2 hover:bg-nb-tile-2 hover:text-nb-ink'
                  }`}>
                  <item.icon className={`size-4 ${activeTab === item.id ? 'text-nb-llm' : 'text-nb-muted'}`} />
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 p-8">
        <div className="mx-auto min-w-[512px] max-w-screen-lg">{renderTabContent()}</div>
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
