/**
 * One report-row policy for browser downloads and host-side CSV exports.
 * Selected destination status takes precedence, then resolution errors, explicit
 * exclusions, and untouched source rows. Preserve unresolved raw input so review
 * reports explain what could not be matched instead of dropping that occurrence.
 */
module.exports = function transferReportRow(row) {
  return {
    candidate: row.track?.candidate || row.raw || { title: row.error },
    report: {
      status: row.selected
        ? "selected"
        : row.error
          ? "unresolved"
          : row.include === false
            ? "skipped"
            : "source",
      destinationId: row.selected?.providerItemId || "",
      score: row.selected?.score || "",
      error: row.error || "",
    },
  };
};
