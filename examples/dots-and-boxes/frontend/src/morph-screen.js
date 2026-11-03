// Keeps the screen steady while the game is updated. duel-game-core's
// shell redraws `#screen` by assigning `innerHTML` on every status change
// (an opponent's move, a table appearing in the lobby, the reply to your
// own click). A plain assignment throws the whole DOM away, which restarts
// every CSS animation, drops hover and focus, and reads as a flicker.
//
// `steadyScreen(el)` shadows that element's `innerHTML` setter: the new
// markup is parsed and morphed onto the existing nodes (morphdom), so only
// what changed is touched — a new pencil line is inserted and animates
// once, a score digit changes, a hit area disappears. When the screen
// KIND changes (lobby -> table, game -> debrief), the content is replaced
// outright so the page-turn fade plays for the new screen as a whole.
// `kindOf()` tells the two apart; the shell's own click handling, spinner
// and countdown patching keep working because they query the DOM after
// each assignment, exactly as before.

import morphdom from "morphdom";

export function steadyScreen(el, kindOf) {
  const native = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  let lastKind = null;

  Object.defineProperty(el, "innerHTML", {
    configurable: true,
    get() {
      return native.get.call(this);
    },
    set(html) {
      const kind = kindOf();
      if (kind !== lastKind || this.childElementCount === 0) {
        lastKind = kind;
        native.set.call(this, html);
        return;
      }
      const next = this.cloneNode(false);
      native.set.call(next, html);
      morphdom(this, next, {
        childrenOnly: true,
        onBeforeElUpdated(from, to) {
          // Untouched subtrees are skipped wholesale.
          return !from.isEqualNode(to);
        },
      });
    },
  });
}
