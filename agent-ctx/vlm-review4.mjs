import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';

const zai = await ZAI.create();
const b64 = fs.readFileSync('/home/z/my-project/agent-ctx/footer-fixed.png').toString('base64');
const res = await zai.chat.completions.createVision({
  messages: [
    { role: 'user', content: [
      { type: 'text', text: `This is a viewport screenshot showing the footer of an e-commerce site (teal background), after a bug fix. Verify: 1) Are footer links now clearly stacked VERTICALLY — each link on its own line with even spacing — in every group (Shopping, Customer service, Sell on NOMOFEE, Earn with NOMOFEE)? 2) Any remaining run-together/merged link text? 3) Bottom bar contents? Answer concisely.` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
    ]}
  ],
  thinking: { type: 'disabled' }
});
console.log(res.choices[0].message.content);
