// Custom Cursor Logic
const cursor = document.getElementById('cursor');
const cursorBlur = document.getElementById('cursor-blur');

document.addEventListener('mousemove', (e) => {
    gsap.to(cursor, { x: e.clientX, y: e.clientY, duration: 0 });
    gsap.to(cursorBlur, { x: e.clientX - 16, y: e.clientY - 16, duration: 0.15 });
});

// Three.js Background
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('bg-canvas'),
    antialias: true,
    alpha: true
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

// Particles
const particlesGeometry = new THREE.BufferGeometry();
const particlesCount = 5000;
const posArray = new Float32Array(particlesCount * 3);

for(let i=0; i < particlesCount * 3; i++) {
    posArray[i] = (Math.random() - 0.5) * 10;
}

particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

const particlesMaterial = new THREE.PointsMaterial({
    size: 0.005,
    color: 0x00f2ff,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending
});

const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
scene.add(particlesMesh);

camera.position.z = 3;

// Mouse interaction for 3D scene
let mouseX = 0;
let mouseY = 0;

document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth) - 0.5;
    mouseY = (e.clientY / window.innerHeight) - 0.5;
});

function animate() {
    requestAnimationFrame(animate);
    
    particlesMesh.rotation.y += 0.001;
    particlesMesh.rotation.x += 0.001;

    gsap.to(particlesMesh.rotation, {
        x: mouseY * 0.5,
        y: mouseX * 0.5,
        duration: 2
    });

    renderer.render(scene, camera);
}

animate();

// Handle Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// GSAP Animations
gsap.registerPlugin(ScrollTrigger);

// Hero Entry
gsap.from(".glitch-text", {
    opacity: 0,
    y: 100,
    duration: 1.5,
    ease: "power4.out",
    delay: 0.5
});

gsap.from(".hero-sub", {
    opacity: 0,
    y: 30,
    duration: 1,
    ease: "power3.out",
    delay: 1
});

gsap.from(".hero-btns", {
    opacity: 0,
    duration: 1,
    delay: 1.5
});

// Scroll Reveals
const reveals = document.querySelectorAll('.reveal');
reveals.forEach((el) => {
    gsap.to(el, {
        scrollTrigger: {
            trigger: el,
            start: "top 85%",
            toggleActions: "play none none reverse"
        },
        opacity: 1,
        y: 0,
        duration: 1.2,
        ease: "power3.out"
    });
});

// Magnetic Button Effect
const buttons = document.querySelectorAll('.btn-primary, .btn-secondary, .nav-cta');
buttons.forEach(btn => {
    btn.addEventListener('mousemove', (e) => {
        const rect = btn.getBoundingClientRect();
        const x = e.clientX - rect.left - rect.width / 2;
        const y = e.clientY - rect.top - rect.height / 2;
        
        gsap.to(btn, {
            x: x * 0.3,
            y: y * 0.3,
            duration: 0.3
        });
    });
    
    btn.addEventListener('mouseleave', () => {
        gsap.to(btn, {
            x: 0,
            y: 0,
            duration: 0.5,
            ease: "elastic.out(1, 0.3)"
        });
    });
});
