import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bookr.reader',
  appName: '纸墨书房',
  webDir: '../web/dist',
  server: { androidScheme: 'https' },
  android: { backgroundColor: '#F6F1E7' },
};

export default config;
