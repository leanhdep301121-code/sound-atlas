try {
  document.documentElement.dataset.theme = localStorage.getItem('sound-atlas-theme') === 'dark' ? 'dark' : 'light';
} catch { document.documentElement.dataset.theme = 'light'; }
