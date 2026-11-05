// Test-only SQL adapter shared by generated test suites after the operator's
// transaction fix. It is not a substitute for the independent PostgreSQL test.
module.exports = function answerMutation(store, sql, params) {
  if (/^SELECT id, score, state FROM games WHERE id/.test(sql)) {
    return { rows: store.games.filter(g => g.id === params[0]).map(g => ({ id: g.id, score: g.score, state: g.state })) };
  }
  if (/^INSERT INTO game_answers /.test(sql)) {
    const [gameId, questionId, answer, correct, scored] = params;
    let row = store.answers.find(a => a.game_id === gameId && a.question_id === questionId);
    if (!row) {
      row = { id: store.answers.length + 1, game_id: gameId, question_id: questionId };
      store.answers.push(row);
    }
    Object.assign(row, { answer, correct, scored: !!row.scored || scored });
    return { rows: [row] };
  }
  if (/^UPDATE games SET score = score \+ \$1, current_question_index/.test(sql)) {
    const row = store.games.find(g => g.id === params[3]);
    if (!row) return { rows: [] };
    row.score += params[0];
    row.current_question_index = params[1];
    row.state = params[2];
    return { rows: [row] };
  }
  return null;
};
