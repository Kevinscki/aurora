const puzzleData = {
    gridSize: 12,
    words: [
        { word: 'PHISHING', row: 2, col: 2, dir: 'across', num: 1, clue: 'Fraudulent emails to steal data.' },
        { word: 'FIREWALL', row: 1, col: 4, dir: 'down', num: 2, clue: 'Network security system that monitors traffic.' },
        { word: 'ENCRYPT', row: 4, col: 4, dir: 'across', num: 3, clue: 'Converting data into a secret code.' },
        { word: 'PASSWORD', row: 4, col: 9, dir: 'down', num: 4, clue: 'Secret string used for authentication.' },
        { word: 'MALWARE', row: 8, col: 4, dir: 'across', num: 5, clue: 'Software designed to disrupt or damage.' },
    ]
};

function initGame() {
    const gridEl = document.getElementById('crossword-grid');
    const acrossList = document.getElementById('across-clues');
    const downList = document.getElementById('down-clues');
    
    // Update grid CSS for new size
    gridEl.style.gridTemplateColumns = `repeat(${puzzleData.gridSize}, 40px)`;
    gridEl.style.gridTemplateRows = `repeat(${puzzleData.gridSize}, 40px)`;
    
    gridEl.innerHTML = ''; // Clear grid

    // Create grid
    for (let r = 0; r < puzzleData.gridSize; r++) {
        for (let c = 0; c < puzzleData.gridSize; c++) {
            const cell = document.createElement('div');
            cell.classList.add('cell', 'empty');
            cell.dataset.row = r;
            cell.dataset.col = c;
            gridEl.appendChild(cell);
        }
    }

    // Place words
    puzzleData.words.forEach(w => {
        for (let i = 0; i < w.word.length; i++) {
            let r = w.dir === 'across' ? w.row : w.row + i;
            let c = w.dir === 'across' ? w.col + i : w.col;
            
            const cell = document.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
            if (cell) {
                cell.classList.remove('empty');
                
                if (!cell.querySelector('input')) {
                    const input = document.createElement('input');
                    input.maxLength = 1;
                    input.dataset.answer = w.word[i];
                    cell.appendChild(input);
                }
                
                if (i === 0) {
                    const num = document.createElement('span');
                    num.classList.add('num');
                    num.textContent = w.num;
                    cell.appendChild(num);
                }
            }
        }

        const li = document.createElement('li');
        li.textContent = `${w.num}. ${w.clue}`;
        if (w.dir === 'across') acrossList.appendChild(li);
        else downList.appendChild(li);
    });
}

document.getElementById('check-btn').addEventListener('click', () => {
    const inputs = document.querySelectorAll('.cell input');
    let allCorrect = true;
    
    inputs.forEach(input => {
        if (input.value.toUpperCase() === input.dataset.answer) {
            input.style.color = '#00ff41';
        } else {
            input.style.color = '#ff4e4e';
            allCorrect = false;
        }
    });

    const feedback = document.getElementById('feedback');
    if (allCorrect) {
        feedback.textContent = "ACCESS GRANTED: You are a Security Pro! 🏆";
        feedback.style.color = "#00ff41";
    } else {
        feedback.textContent = "ACCESS DENIED: Some answers are incorrect. Try again!";
        feedback.style.color = "#ff4e4e";
    }
});

document.getElementById('reset-btn').addEventListener('click', () => {
    const inputs = document.querySelectorAll('.cell input');
    inputs.forEach(input => {
        input.value = '';
        input.style.color = 'var(--primary)';
    });
    document.getElementById('feedback').textContent = '';
});

initGame();
