/**
 * Song restrictions.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
module.exports = function createSongRestrictions({ now }) {
  let banned = [],
    timed = {};
  const clean = () => {
    timed = Object.fromEntries(Object.entries(timed).filter(([, until]) => until > Number(now())));
  };
  return {
    count() {
      return banned.length;
    },
    reason(identity) {
      clean();
      return banned.includes(identity) ? "song_blocked" : timed[identity] ? "song_timed_out" : "";
    },
    apply(action, identity, minutes) {
      clean();
      if (action === "unblock_song") banned = banned.filter((value) => value !== identity);
      else if (action === "untimeout_song") delete timed[identity];
      else if (action === "block_song") {
        banned = [...new Set([...banned, identity])].slice(-250);
      } else {
        timed[identity] = Number(now()) + minutes * 60000;
        timed = Object.fromEntries(Object.entries(timed).slice(-250));
      }
      return {
        ok: true,
        code: action,
        identity,
        timedOutUntil: timed[identity] || 0,
      };
    },
    export() {
      clean();
      return {
        blockedSongIdentities: [...banned],
        timedSongIdentities: { ...timed },
      };
    },
    restore(snapshot) {
      banned = Array.isArray(snapshot.blockedSongIdentities)
        ? snapshot.blockedSongIdentities
            .slice(-250)
            .filter((value) => typeof value === "string" && value.length <= 220)
        : [];
      timed = Object.fromEntries(
        Object.entries(snapshot.timedSongIdentities || {})
          .filter(([identity, until]) => identity.length <= 220 && Number.isFinite(until))
          .slice(-250),
      );
      clean();
    },
  };
};
