// This file serves as a bridge between your app and Firebase

// Import Firebase from CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getFirestore, 
  collection, 
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Your Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyC6QCw_zbj-icjkZBX5GrVRN-Wwo1zpIlY",
  authDomain: "cdrrmo-bd875.firebaseapp.com",
  projectId: "cdrrmo-bd875",
  storageBucket: "cdrrmo-bd875.firebasestorage.app",
  messagingSenderId: "451006958185",
  appId: "1:451006958185:web:85b0597743cfa90f1ef0f8"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const firestore = getFirestore(app);

// Export all the Firebase services and functions needed
export {
  firestore,
  collection,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  doc,
  query,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  where,
  serverTimestamp
};