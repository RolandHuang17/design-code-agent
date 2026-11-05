// Run with playwright-cli -s=space-demo run-code --filename scripts/browser_full_flow.js
// Start on Question 1 after logging in and clicking Play. Published demo fixtures only.
async (page) => {
  const cases = [
    ['What is 1/2 + 1/4?', '3/4'],
    ['What is 3/5 - 1/5?', '2/5'],
    ['What is 2/3 × 3/4?', '1/2'],
    ['What is 3/4 ÷ 1/2?', '3/2'],
    ['Which fraction is equivalent to 2/3?', '4/6'],
    ['What is 5/6 - 1/3?', '1/2'],
    ['What is 1/4 + 3/8?', '5/8'],
    ['Which fraction is smallest: 1/2, 1/4, 3/4?', '1/4'],
    ['What is 7/8 - 1/4?', '5/8'],
    ['A pizza has 8 slices. You eat 3. What fraction remains?', '5/8']
  ];
  const first = await page.getByRole('heading', { name: /^Question \d+ of 10$/ }).innerText();
  const start = Number(first.match(/Question (\d+)/)[1]) - 1;
  for (let i = start; i < cases.length; i++) {
    await page.getByRole('heading', { name: `Question ${i + 1} of 10`, exact: true }).waitFor();
    let current;
    for (const item of cases) {
      if (await page.getByText(item[0], { exact: true }).isVisible()) current = item;
    }
    if (!current) throw new Error('Unexpected visible question');
    await page.getByRole('textbox', { name: 'Type a fraction, e.g. 1/2' }).fill(current[1]);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.getByText(`Correct! (score: ${i + 1})`, { exact: true }).waitFor();
  }
  await page.getByRole('heading', { name: 'Mission Complete', exact: true }).waitFor();
  await page.getByText('Perfect! You are a true Fraction Master!', { exact: true }).waitFor();
  await page.getByText('correct out of 10', { exact: true }).waitFor();
  console.log(JSON.stringify({ kind: 'independent_browser_flow', status: 'passed', questions: 10, score: 10, ending: 'Mission Complete' }));
}
