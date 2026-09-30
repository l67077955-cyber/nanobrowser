import { useEffect, useState } from 'react';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

interface OpenRouterModel {
  id: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

export interface OpenRouterModels {
  /** every chat model */
  all: string[];
  /** the ones that accept images */
  image: string[];
}

/** The chat models of an OpenRouter model list; batch variants answer hours later and are left out */
export function chatModelIds(models: OpenRouterModel[]): OpenRouterModels {
  const chat = models.filter(
    model => model.architecture?.output_modalities?.includes('text') && !model.id.endsWith(':batch'),
  );
  const ids = (list: OpenRouterModel[]) => list.map(model => model.id).sort();
  return {
    all: ids(chat),
    image: ids(chat.filter(model => model.architecture?.input_modalities?.includes('image'))),
  };
}

/**
 * The models OpenRouter offers right now, as its public model list reports them.
 * @param baseUrl the provider's base URL; undefined when there is no OpenRouter provider, then nothing is loaded
 * @returns null until the list is loaded, and when it cannot be
 */
export function useOpenRouterModels(baseUrl: string | undefined): OpenRouterModels | null {
  const [models, setModels] = useState<OpenRouterModels | null>(null);

  useEffect(() => {
    if (baseUrl === undefined) return;
    let cancelled = false;
    fetch(`${(baseUrl || OPENROUTER_BASE_URL).replace(/\/+$/, '')}/models`)
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((body: { data?: OpenRouterModel[] }) => {
        if (!cancelled) setModels(chatModelIds(body.data ?? []));
      })
      .catch(error => {
        console.error('Error loading the OpenRouter model list:', error);
        if (!cancelled) setModels(null);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  return baseUrl === undefined ? null : models;
}
