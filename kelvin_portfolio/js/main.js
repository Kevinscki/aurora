const bootMessages = [
    "Loading KelvinOS Kernel...",
    "Mounting encrypted volumes...",
    "Initializing Digital Garden...",
    "Establishing secure tunnel to Arusha...",
    "System Ready."
];

const hubData = {
    "00": [
        { title: "LlamaTerm (Flagship)", desc: "AI-Enhanced Linux Terminal. Integrates local LLMs for command completion, scripting assistance, and cybersecurity-focused functionality. (Final Year Project - IAA)." },
        { title: "Strategic Mindset", desc: "Decimal-indexed knowledge management system for high-complexity project tracking (00_STRATEGY to 30_ARCHIVE)." },
        { title: "Agentic AI Operators", desc: "Research into autonomous LLM agents for security automation using n8n and Activepieces." }
    ],
    "10": [
        { title: "Prompt the Flag (7/7)", desc: "Complete mastery of prompt injection and LLM jailbreaking levels. Status: ELITE." },
        { title: "TCRA AI Competition", desc: "Built an AI model trained on logistics patterns for anomaly detection. Handled full data workflow and model setup." },
        { title: "eJPT Certification", desc: "Verified Junior Penetration Tester credentials via INE. Focus on network recon and exploitation." },
        { title: "Full Kill-Chain", desc: "End-to-end penetration testing from enumeration to exploitation." }
    ],
    "20": [
        { title: "Traffic Analysis", desc: "Deep packet inspection and network forensics using Wireshark and the ELK stack." },
        { title: "Blue Team Ops", desc: "Hardening systems and threat detection strategies. Experience with Hexstrike MCP." }
    ],
    "30": [
        { title: "Archived Lab Reports", desc: "Documentation of solved CTFs (TryHackMe, HTB, PicoCTF) and UrchinSec bootcamp labs." }
    ]
};

async function runBoot() {
    const textEl = document.getElementById('boot-text');
    const progEl = document.querySelector('.progress');
    
    for (let i = 0; i < bootMessages.length; i++) {
        const line = document.createElement('div');
        line.textContent = `> ${bootMessages[i]}`;
        textEl.appendChild(line);
        progEl.style.width = `${((i + 1) / bootMessages.length) * 100}%`;
        await new Promise(r => setTimeout(r, 400));
    }
    
    gsap.to("#boot-screen", { opacity: 0, duration: 0.8, onComplete: () => {
        document.getElementById('boot-screen').style.display = 'none';
    }});
}

function openWindow(id) {
    const win = document.getElementById(id);
    win.style.display = 'flex';
    gsap.from(win, { scale: 0.9, opacity: 0, duration: 0.3, ease: "back.out" });
    if(id === 'hub-window') filterHub('00');
}

function closeWindow(id) {
    const win = document.getElementById(id);
    gsap.to(win, { scale: 0.9, opacity: 0, duration: 0.2, onComplete: () => {
        win.style.display = 'none';
    }});
}

function filterHub(category) {
    const content = document.getElementById('hub-content');
    const items = document.querySelectorAll('.nav-item');
    
    items.forEach(item => {
        item.classList.remove('active');
        if(item.textContent.startsWith(category)) item.classList.add('active');
    });

    content.innerHTML = hubData[category].map(proj => `
        <div class="project-card">
            <h3>${proj.title}</h3>
            <p>${proj.desc}</p>
        </div>
    `).join('');
}

function toggleTerminal() {
    const term = document.getElementById('terminal-window');
    if(term.style.display === 'none') {
        openWindow('terminal-window');
        document.getElementById('term-input').focus();
    } else {
        closeWindow('terminal-window');
    }
}

const termCmds = {
    "help": "Commands: about, skills, certs, ptf, llama, clear",
    "about": "Kelvin Rutatina | Cybersecurity Graduate (IAA) | AI Security Researcher",
    "skills": "Offensive: eJPT, Prompt Injection\nAI: Ollama, n8n, Activepieces, LlamaTerm\nTools: Nmap, Wireshark, ELK Stack, Hexstrike MCP",
    "certs": "eJPT (INE) | AI 101 (TCM Security) | UrchinSec Graduate",
    "ptf": "Prompt the Flag: 7/7 Levels Solved. Status: ELITE",
    "llama": "LlamaTerm: AI-Enhanced terminal integrating local LLMs for security automation. Project status: COMPLETE.",
    "clear": "CLEAR"
};

function handleTerminal(input) {
    const output = document.getElementById('term-output');
    const cmd = input.toLowerCase().trim();
    
    if(cmd === 'clear') {
        output.innerHTML = '';
        return;
    }

    const response = termCmds[cmd] || `zsh: command not found: ${cmd}`;
    const line = document.createElement('div');
    line.innerHTML = `<div style="color: #888; margin-top:10px;">kelvin@operator ~ % ${input}</div><div>${response}</div>`;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
}

window.onload = () => {
    runBoot();
    
    const termInput = document.getElementById('term-input');
    termInput.addEventListener('keydown', (e) => {
        if(e.key === 'Enter') {
            handleTerminal(termInput.value);
            termInput.value = '';
        }
    });

    setInterval(() => {
        document.getElementById('clock').textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    }, 1000);
};
