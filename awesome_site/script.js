document.addEventListener('DOMContentLoaded', () => {
    console.log('Awesome Site Loaded');
    
    // Simple scroll effect for nav
    window.addEventListener('scroll', () => {
        const nav = document.querySelector('nav');
        if (window.scrollY > 50) {
            nav.style.padding = '1rem 10%';
            nav.style.background = 'rgba(10, 10, 10, 0.9)';
        } else {
            nav.style.padding = '2rem 10%';
            nav.style.background = 'transparent';
        }
    });
});
