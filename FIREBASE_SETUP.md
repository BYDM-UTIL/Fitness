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

### iPhone note
- In the current stable app mode, iPhone uses local reminders only.
- Firebase cloud push registration is kept disabled on iPhone to avoid unstable registration failures.

## 8) Enable free cloud push (FCM)
This setup is fully free and gives real cloud push delivery.

1. In Firebase Console open Project settings -> Cloud Messaging.
2. Under Web configuration, generate a Web Push certificate key (VAPID).
3. Put this value in local firebase-config.js as vapidKey.
4. Deploy hosting again.
5. In app Settings -> Reminders, enable notifications and save.
6. Confirm that status says Push cloud is active.

This cloud push flow is intended for supported browsers/platforms. In the stabilized iPhone path, the app stays on local reminders only.

### Test cloud push for free
1. Open Firebase Console -> Cloud Messaging -> Create campaign.
2. Choose Web Push notification.
3. Send a test message to the token registered by the app.
4. You will get a real push from the cloud, even without local timer.

### Important free limitation
- Fully automatic daily push from cloud scheduler is not fully free in Firebase, because scheduled cloud jobs require billing-enabled infrastructure.
- Fully free mode supports real cloud push delivery, but trigger is manual (for example from Firebase Console test/campaign).

## Notes
- Data is saved in Firestore cloud per anonymous user.
- If you uninstall the app or clear Safari website data, a new anonymous user is created.
- To keep data across reinstalls/devices, later add email/Google sign-in.
