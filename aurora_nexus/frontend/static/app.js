const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const sysStats = document.getElementById('sys-stats');

// WebSocket Connection
const socket = new WebSocket(`ws://${window.location.host}/ws/chat`);

socket.onmessage = (event) => {
    addMessage(event.data, 'ai');
};

function addMessage(text, sender) {
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.textContent = text;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function sendMessage() {
    const text = userInput.value;
    if (text) {
        addMessage(text, 'user');
        socket.send(text);
        userInput.value = '';
    }
}

sendBtn.onclick = sendMessage;
userInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };

// System Stats Update
setInterval(async () => {
    const res = await fetch('/api/system');
    const data = await res.json();
    sysStats.textContent = `CPU: ${data.cpu}% | RAM: ${data.ram}%`;
}, 2000);
