import { config } from './config';

/** The agent's name on its AI calls: its Rushr handle, else its strategy. */
const agentTag = config.handle || `rushr-${config.strategy}`;

/**
 * The agent's brain: one chat completion on an OpenAI-compatible API. Raeto by default (every call gets a
 * receipt and counts toward the agent's public cost statement); any other compatible provider works too.
 */

export async function listModels(): Promise<string[]> {
  const r = await fetch(`${config.ai.baseUrl}/models`, { headers: { authorization: `Bearer ${config.ai.apiKey}` } });
  if (!r.ok) throw new Error(`GET /models: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id);
}

/** Asks the model and parses its JSON answer. Throws on HTTP errors or a reply that isn't JSON. */
export async function askJson<T>(system: string, user: string): Promise<T> {
  const r = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    // X-Raeto-Agent / user: Raeto books each call to this agent, so several agents can share one key and
    // still get their own cost rows in the console. Other OpenAI-compatible providers ignore the header.
    headers: { authorization: `Bearer ${config.ai.apiKey}`, 'content-type': 'application/json', 'x-raeto-agent': agentTag },
    body: JSON.stringify({
      model: config.ai.model,
      user: agentTag,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${system}\nAnswer with one JSON object only.` },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`AI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? '';
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`AI reply is not JSON: ${text.slice(0, 200)}`);
  }
}
