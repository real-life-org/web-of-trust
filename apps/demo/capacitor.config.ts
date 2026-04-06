import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.reallife.weboftrust',
  appName: 'Web of Trust',
  webDir: 'dist',
  android: {
    flavor: 'fdroid',
  },
  plugins: {
    LiveUpdate: {
      appId: 'org.reallife.weboftrust',
    },
  },
};

export default config;
