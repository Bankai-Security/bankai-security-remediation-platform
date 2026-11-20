/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_BANKAI_DESKTOP_DOWNLOAD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
interface Window {
  __BANKAI_CONFIG__?: { apiBaseUrl?: string };
}
