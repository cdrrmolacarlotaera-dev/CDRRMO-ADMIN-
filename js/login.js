import { firestore, collection, query, where, getDocs } from './firebase-api.js';
import adminLogger from './admin-logger.js';

const DEFAULT_USERNAME = 'admin2026';
const DEFAULT_PASSWORD = 'admin2026';

document.getElementById('togglePassword').addEventListener('click', function() {
    const pwd = document.getElementById('password');
    const icon = this.querySelector('i');
    if (pwd.type === 'password') {
        pwd.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        pwd.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
});

if (sessionStorage.getItem('adminLoggedIn') === 'true') {
    window.location.href = 'rescue.html';
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errorMsg = document.getElementById('errorMsg');
    const errorText = document.getElementById('errorText');
    
    errorMsg.style.display = 'none';

    try {
        const adminsRef = collection(firestore, 'AdminUsers');
        const q = query(adminsRef, where('username', '==', username));
        const snapshot = await getDocs(q);
        
        let authenticated = false;
        
        if (!snapshot.empty) {
            const adminData = snapshot.docs[0].data();
            if (adminData.password === password) {
                authenticated = true;
            }
        }
        
        if (!authenticated && username === DEFAULT_USERNAME && password === DEFAULT_PASSWORD) {
            authenticated = true;
        }
        
        if (authenticated) {
            sessionStorage.setItem('adminLoggedIn', 'true');
            sessionStorage.setItem('adminUsername', username);
            
            try {
                await adminLogger.log('admin_login', 'Admin', username, { timestamp: new Date().toISOString() });
            } catch (logErr) {
                console.error('Failed to log login:', logErr);
            }
            
            window.location.href = 'rescue.html';
        } else {
            errorText.textContent = 'Invalid username or password';
            errorMsg.style.display = 'block';
        }
    } catch (error) {
        console.error('Login error:', error);
        if (username === DEFAULT_USERNAME && password === DEFAULT_PASSWORD) {
            sessionStorage.setItem('adminLoggedIn', 'true');
            sessionStorage.setItem('adminUsername', username);
            window.location.href = 'rescue.html';
        } else {
            errorText.textContent = 'Login failed. Please try again.';
            errorMsg.style.display = 'block';
        }
    }
});
