// P2P: победитель гонки делится скиллами с проигравшими
const fs = require('fs');
const path = require('path');

const BOXES_DIR = path.join(__dirname, 'boxes');
const SKILLS_SRC = path.join(__dirname, 'skills');

function shareSkillsFromWinner(winnerBox, allBoxes) {
  const result = { winner: winnerBox, shared_with: [], skills_copied: 0, errors: [] };

  if (!allBoxes.includes(winnerBox)) {
    result.errors.push('Winner ' + winnerBox + ' not in allBoxes');
    return result;
  }

  // Собираем все скиллы победителя
  const winnerSkillsDir = path.join(BOXES_DIR, winnerBox, 'skills');
  if (!fs.existsSync(winnerSkillsDir)) {
    // Фолбэк: берём из главного skills/
    result.errors.push('No skills in winner box, using main skills/');
  }

  const sourceDir = fs.existsSync(winnerSkillsDir) ? winnerSkillsDir : SKILLS_SRC;
  const skills = fs.readdirSync(sourceDir).filter(f => f.endsWith('.md'));

  for (const box of allBoxes) {
    if (box === winnerBox) continue;

    const targetDir = path.join(BOXES_DIR, box, 'skills');
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const skill of skills) {
        const src = path.join(sourceDir, skill);
        const dst = path.join(targetDir, skill);
        // Не перезаписываем, если уже есть
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
          result.skills_copied++;
        }
      }
      result.shared_with.push(box);
    } catch (e) {
      result.errors.push(box + ': ' + e.message);
    }
  }

  return result;
}

// CLI: node p2p_share.js <winner_box> <box1,box2,box3>
if (require.main === module) {
  const winner = process.argv[2];
  const boxes = (process.argv[3] || 'agent_1,agent_3,agent_7').split(',');
  const r = shareSkillsFromWinner(winner, boxes);
  console.log(JSON.stringify(r, null, 2));
}

module.exports = { shareSkillsFromWinner };
