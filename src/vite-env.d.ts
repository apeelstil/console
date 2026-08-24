/// <reference types="vite/client" />

import type { SupraDesktopApi } from '../shared/connectionProfiles';

declare global {
  interface Window {
    supraDesktop?: SupraDesktopApi;
  }
}

export {};
