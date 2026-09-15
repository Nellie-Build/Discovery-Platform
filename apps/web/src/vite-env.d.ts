/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Set at build time (see the Dockerfile) to show a small "Testomgeving" badge so this
   * deployment is never mistaken for a later production environment — unset locally. */
  readonly VITE_ENV_LABEL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
