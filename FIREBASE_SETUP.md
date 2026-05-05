# Firebase Setup (Step by Step)

## 1) Create Firebase project
1. Open https://console.firebase.google.com
2. Click Add project
3. Finish project creation

## 2) Add Web app
1. Enter project settings
2. In General tab, click Add app -> Web (</>)
3. Register app name (for example: fitness-web)
4. Copy the firebaseConfig values
5. Copy firebase-config.example.js to firebase-config.js
6. Paste the real firebaseConfig values into firebase-config.js (this file is ignored by git)

## 3) Enable Authentication (Anonymous)
1. In Firebase console open Authentication
2. Click Get started
3. Open Sign-in method tab
4. Enable Anonymous provider

## 4) Create Firestore Database
1. Open Firestore Database
2. Click Create database
3. Start in production mode
4. Choose region close to you

## 5) Install Firebase CLI
Run in project folder:

npx firebase-tools login
npx firebase-tools use --add

Select your Firebase project.

## 6) Deploy rules and hosting
Run:

npx firebase-tools deploy --only firestore:rules
npx firebase-tools deploy --only hosting

## 7) Open on iPhone
1. Open your Hosting URL (https://<project-id>.web.app) in Safari
2. Share -> Add to Home Screen
3. Launch from the icon

## Notes
- Data is saved in Firestore cloud per anonymous user.
- If you uninstall the app or clear Safari website data, a new anonymous user is created.
- To keep data across reinstalls/devices, later add email/Google sign-in.
