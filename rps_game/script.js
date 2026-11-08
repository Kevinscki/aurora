document.addEventListener('DOMContentLoaded', () => {
  const choices = ['rock', 'paper', 'scissors'];
  const resultDiv = document.getElementById('result');
  const playerDiv = document.getElementById('player-choice');
  const computerDiv = document.getElementById('computer-choice');

  document.querySelectorAll('#buttons button').forEach(btn => {
    btn.addEventListener('click', () => {
      const player = btn.dataset.choice;
      const computer = choices[Math.floor(Math.random() * choices.length)];

      playerDiv.textContent = `You: ${capitalize(player)}`;
      computerDiv.textContent = `Computer: ${capitalize(computer)}`;

      const outcome = determineWinner(player, computer);
      resultDiv.textContent = outcome;

      console.log(`Player=${player}, Computer=${computer}, Outcome=${outcome}`);
    });
  });

  function determineWinner(p, c) {
    if (p === c) return "It's a tie!";
    if ((p === 'rock' && c === 'scissors') ||
        (p === 'paper' && c === 'rock') ||
        (p === 'scissors' && c === 'paper')) {
      return 'You win!';
    }
    return 'Computer wins!';
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
});
