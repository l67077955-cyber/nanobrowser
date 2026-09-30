import { useEffect, useMemo, useRef, useState } from 'react';
import { captchaModelStore, captchaModelSuggestions, ProviderTypeEnum, type ProviderConfig } from '@extension/storage';
import { t } from '@extension/i18n';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL_INPUT_ID = 'captcha-model';

interface OpenRouterModel {
  id: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

/** The chat models of an OpenRouter model list that take images; batch variants answer hours later */
export function imageModelIds(models: OpenRouterModel[]): string[] {
  return models
    .filter(
      model =>
        model.architecture?.input_modalities?.includes('image') &&
        model.architecture?.output_modalities?.includes('text') &&
        !model.id.endsWith(':batch'),
    )
    .map(model => model.id)
    .sort();
}

interface CaptchaModelPickerProps {
  /** the saved providers */
  providers: Record<string, ProviderConfig>;
}

/**
 * The model that reads image captchas: a provider and any model name of it. The name is not limited to the
 * provider's model list, as the agents run on text models and the list rarely holds one that takes images.
 */
export const CaptchaModelPicker = ({ providers }: CaptchaModelPickerProps) => {
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [openRouterModels, setOpenRouterModels] = useState<string[] | null>(null);
  // a provider is chosen and its model is not yet: nothing is stored then, and the provider must stay selected
  const choosingRef = useRef(false);

  useEffect(() => {
    const load = async () => {
      try {
        const config = await captchaModelStore.getCaptchaModel();
        // a name that is being typed is not replaced by what an earlier keystroke stored
        if (document.activeElement?.id === MODEL_INPUT_ID) return;
        if (config) {
          choosingRef.current = false;
          setProvider(config.provider);
          setModel(config.modelName);
        } else if (!choosingRef.current) {
          setProvider('');
          setModel('');
        }
      } catch (error) {
        console.error('Error loading captcha model:', error);
      }
    };
    load();
    return captchaModelStore.subscribe(load);
  }, []);

  const providerConfig = providers[provider];
  const isOpenRouter = providerConfig?.type === ProviderTypeEnum.OpenRouter;
  const openRouterBaseUrl = isOpenRouter ? providerConfig.baseUrl || OPENROUTER_BASE_URL : null;

  // OpenRouter says which of its models take images: offer exactly those, as they are today
  useEffect(() => {
    if (!openRouterBaseUrl) return;
    let cancelled = false;
    fetch(`${openRouterBaseUrl.replace(/\/+$/, '')}/models`)
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((body: { data?: OpenRouterModel[] }) => {
        if (!cancelled) setOpenRouterModels(imageModelIds(body.data ?? []));
      })
      .catch(error => {
        console.error('Error loading the OpenRouter model list:', error);
        if (!cancelled) setOpenRouterModels(null);
      });
    return () => {
      cancelled = true;
    };
  }, [openRouterBaseUrl]);

  const suggestions = useMemo(() => {
    if (!providerConfig) return [];
    if (isOpenRouter && openRouterModels && openRouterModels.length > 0) return openRouterModels;
    const own =
      providerConfig.type === ProviderTypeEnum.AzureOpenAI
        ? (providerConfig.azureDeploymentNames ?? [])
        : (providerConfig.modelNames ?? []);
    const known = (providerConfig.type && captchaModelSuggestions[providerConfig.type]) || [];
    return [...new Set([...known, ...own])];
  }, [providerConfig, isOpenRouter, openRouterModels]);

  const save = async (nextProvider: string, nextModel: string) => {
    try {
      const modelName = nextModel.trim();
      if (nextProvider && modelName) {
        await captchaModelStore.setCaptchaModel({ provider: nextProvider, modelName });
      } else {
        // half a choice is no choice: the agent then says that the model is missing
        await captchaModelStore.resetCaptchaModel();
      }
    } catch (error) {
      console.error('Error saving captcha model:', error);
    }
  };

  const handleProviderChange = (nextProvider: string) => {
    choosingRef.current = nextProvider !== '';
    setProvider(nextProvider);
    // a model name belongs to its provider
    setModel('');
    void save(nextProvider, '');
  };

  const handleModelChange = (nextModel: string, typed: boolean) => {
    setModel(nextModel);
    // picked from the list: saved at once. A typed name is saved when the box is left.
    if (!typed && suggestions.includes(nextModel)) void save(provider, nextModel);
  };

  const fieldClass = `flex-1 rounded-md border border-nb-line bg-nb-tile-2 px-3 py-2 text-sm text-nb-ink focus:border-nb-llm focus:outline-none`;
  const labelClass = `w-24 text-sm font-medium text-nb-ink-2`;

  return (
    <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
      <h2 className={`mb-4 text-left text-base font-semibold tracking-tight text-nb-ink`}>
        {t('options_models_captcha_header')}
      </h2>
      <p className={`mb-4 text-sm text-nb-muted`}>{t('options_models_captcha_desc')}</p>

      <div className={`space-y-4 rounded-lg border border-nb-hair bg-nb-tile-2 p-4`}>
        <div className="flex items-center">
          <label htmlFor="captcha-provider" className={labelClass}>
            {t('options_models_captcha_provider')}
          </label>
          <select
            id="captcha-provider"
            className={fieldClass}
            value={providerConfig ? provider : ''}
            onChange={e => handleProviderChange(e.target.value)}>
            <option value="">{t('options_models_captcha_chooseProvider')}</option>
            {Object.entries(providers).map(([id, config]) => (
              <option key={id} value={id}>
                {config.name || id}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center">
          <label htmlFor={MODEL_INPUT_ID} className={labelClass}>
            {t('options_models_labels_model')}
          </label>
          <input
            id={MODEL_INPUT_ID}
            type="text"
            list="captcha-model-suggestions"
            autoComplete="off"
            spellCheck={false}
            className={fieldClass}
            disabled={!providerConfig}
            placeholder={t('options_models_captcha_modelPlaceholder')}
            value={model}
            onChange={e => {
              // a pick from the list arrives as a replacement of the whole text, typing as insertions and deletions
              const inputType = (e.nativeEvent as InputEvent).inputType;
              handleModelChange(e.target.value, inputType !== undefined && inputType !== 'insertReplacementText');
            }}
            onBlur={e => void save(provider, e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <datalist id="captcha-model-suggestions">
            {suggestions.map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>

        {providerConfig && (
          <p className={`text-xs text-nb-muted`}>
            {isOpenRouter && openRouterModels && openRouterModels.length > 0
              ? t('options_models_captcha_openRouterHint', [openRouterModels.length.toString()])
              : t('options_models_captcha_anyModelHint')}
          </p>
        )}
      </div>
    </div>
  );
};
