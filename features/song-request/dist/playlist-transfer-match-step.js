module.exports = async ({ job, rows, match, store, save }) => {
      const index = job.processed;
      if (index >= rows.length) { job.state = 'review'; return await save(); }
      const row = rows[index];
      if (row.track && row.include !== false) {
        const source = row.track.candidate;
        const reply = await match(source, job.target || 'tidal', job.adaptive !== false);
        if (!reply.ok) {
          if (/rate_limited|busy/.test(reply.error)) {
            const delay = Number.isFinite(reply.retryAfterMs) && reply.retryAfterMs > 0 ? Math.ceil(reply.retryAfterMs) : 60000;
            job.retryAt = Date.now() + delay; job.rateLimitSource = reply.rateLimitSource || '';
            job.error = job.rateLimitSource === 'local' ? 'Waiting for RaveLink search allowance' : job.rateLimitSource === 'soundcloud' ? 'SoundCloud requested a pause' : job.rateLimitSource === 'concurrency' ? 'Waiting for an active catalog search' : 'Waiting for catalog rate limit';
            return await save();
          }
          if (/no_eligible_match|no_results|confidence_too_low|duration_limit/.test(reply.error)) { row.choices = []; row.selected = null; row.error = reply.error; job.processed++; job.error = ''; job.retryAt = 0; job.rateLimitSource = ''; await store.page(job, rows, index); await save(); return; }
          throw new Error(reply.error);
        }
        row.choices = reply.choices;
        row.selected = reply.same ? row.choices[0] : null;
        row.error = row.choices.length ? '' : 'No destination match found';
      }
      job.processed++; job.error = ''; job.retryAt = 0; job.rateLimitSource = ''; await store.page(job, rows, index); await save();
};
