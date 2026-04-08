(function() {
  const isLoggedIn = sessionStorage.getItem('adminLoggedIn') === 'true';
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  
  if (currentPage === 'index.html' || currentPage === '') return;
  
  if (!isLoggedIn) {
    window.location.replace('index.html');
  }
})();
