# Get the APK on your phone (about 15 minutes, all free)

The app needs its backend (server.ts, which holds your Gemini key) online, because an APK cannot run Node.

## 1. Host the backend
1. Push this folder to a new GitHub repo.
2. On render.com: New > Blueprint > pick the repo (render.yaml is included).
3. Add the env var GEMINI_API_KEY. Copy the URL you get, e.g. https://studytest-ai.onrender.com
   (Open it on your phone first: the mobile-optimised site works as-is, and Chrome > "Add to Home screen" gives an app-like install.)

## 2. Build the APK in the cloud
1. GitHub repo > Settings > Secrets and variables > Actions > Variables > New variable:
   API_BASE_URL = your Render URL (no trailing slash).
2. Actions tab > "Build Android APK" > Run workflow.
3. When it finishes, the APK is published automatically under the repo's Releases page as StudyTest-AI.apk. Share that page link; anyone can download and install it (allow "install unknown apps").

## Build locally instead (needs Node 20+, JDK 21, Android Studio)
    npm install
    VITE_API_BASE=https://your-backend-url npm run build
    npx cap add android && npx cap sync android
    cd android && ./gradlew assembleDebug
APK: android/app/build/outputs/apk/debug/app-debug.apk
