import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.studytest.app',
  appName: 'StudyTest AI',
  webDir: 'dist',
  android: { allowMixedContent: false },
  plugins: {
    SplashScreen: { launchShowDuration: 800, backgroundColor: '#090d16' },
    StatusBar: { style: 'DARK', backgroundColor: '#090d16' },
  },
};
export default config;
