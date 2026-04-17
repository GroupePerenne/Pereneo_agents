/**
 * Wrapper Anthropic Claude API.
 *
 * Usage dans David (orchestration conversationnelle avec les consultants)
 * et dans le générateur de séquence (sans mémoire, JSON strict).
 *
 * Variable d'env requise : ANTHROPIC_API_KEY
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_DEFAULT = 'claude-sonnet-4-20250514';

async function callClaude({ system, messages, model = MODEL_DEFAULT, maxTokens = 2000, temperature = 0.7 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non défini');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }
  const data = await res.json();
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return { text, raw: data };
}

/**
 * Parse un JSON embedded dans une réponse Claude (tolérant aux ```json fences).
 */
function parseJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

module.exports = { callClaude, parseJson };
