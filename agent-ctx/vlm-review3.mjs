import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';

async function analyze(zai, path, prompt) {
  const b64 = fs.readFileSync(path).toString('base64');
  const res = await zai.chat.completions.createVision({
    messages: [
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
      ]}
    ],
    thinking: { type: 'disabled' }
  });
  return res.choices[0].message.content;
}

const zai = await ZAI.create();

const fullPrompt = `This is a full-page view of a desktop e-commerce marketplace homepage, built by stitching real viewport screenshots while scrolling (the sticky header repeats at each 900px seam — ignore that artifact; also a floating chat button repeats bottom-left). Analyze carefully: 1) List ALL sections in order top to bottom and confirm which of these are present: utility bar, header, dark nav bar, hero carousel, quick-access shortcuts, campaign showcase, flash deals, category grid, trending products, featured picks, featured stores, new arrivals, footer. 2) Product cards: prices (RM), struck-through compare-at prices, discount % badges, star ratings, sold counts? 3) Flash deals: countdown timer present? Add-to-cart button and heart icon on cards? 4) Category grid: how many tiles, icons + sub-category counts? 5) Featured stores: how are stores displayed? 6) Footer: brand block, how many link groups with what links, bottom bar contents? Is link text clearly spaced (each link on its own line)? 7) Visual defects: broken images, placeholder letter tiles, overlaps, misalignment, stretched images, text overflow, awkward empty space. 8) Does the overall design read as a coherent modern teal-branded Malaysian marketplace (not red, not a PG Mall clone)?`;

const footerPrompt = `Close-up of an e-commerce site footer on teal background. 1) List the brand block and every link group with its exact links. 2) Are links vertically stacked with clear spacing (each on its own line), or do separate link labels visually merge/run together? 3) Describe the bottom bar (copyright text, CTA button). 4) Any defects: text overlap, cramped spacing, misalignment?`;

const tilePrompt = `Close-up of a promotional side tile next to a hero carousel on an e-commerce homepage. Describe exactly what you see: background, any large ghosted letters or watermark text, the heading, subtext, badge, CTA button, and whether any text elements overlap each other or look broken/garbled.`;

console.log('=== STITCHED FINAL FULL ===');
try { console.log(await analyze(zai, '/home/z/my-project/agent-ctx/stitched-final.png', fullPrompt)); }
catch (e) { console.error('full failed:', e.message); }

console.log('=== FOOTER REAL ===');
try { console.log(await analyze(zai, '/home/z/my-project/agent-ctx/footer-real.png', footerPrompt)); }
catch (e) { console.error('footer failed:', e.message); }

console.log('=== HERO SECONDARY TILE ===');
try { console.log(await analyze(zai, '/home/z/my-project/agent-ctx/hero-secondary.png', tilePrompt)); }
catch (e) { console.error('tile failed:', e.message); }
