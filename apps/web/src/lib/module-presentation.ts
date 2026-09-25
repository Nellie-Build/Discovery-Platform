import type { IconName } from '../components/ui/icon';
const modules: Record<string, { icon: IconName; description: string }> = {
  vacancies: { icon: 'vacancies', description: 'Ontdek vacatures en breng nieuwe kansen op de arbeidsmarkt in kaart.' },
  tenders: { icon: 'tenders', description: 'Volg aanbestedingen, publicaties en sluitingsdatums op één plek.' },
  companies: { icon: 'companies', description: 'Vind bedrijven die passen bij je markt en je volgende groeistap.' },
};
export const modulePresentation = (id: string) =>
  modules[id] ?? {
    icon: 'module' as const,
    description: 'Verken de projecten en resultaten van deze Discovery-module.',
  };
export const moduleUrl = (id: string) => `/projects?domain=${encodeURIComponent(id)}`;
