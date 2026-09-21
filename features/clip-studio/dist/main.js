let active = false;

async function activate() {
  active = true;
}

async function handleRequest(request) {
  if (request.capability === "video.projects.read.v1" && request.method === "status") {
    return {
      ok: true,
      phase: "infrastructure",
      active,
      projects: 0,
      message: "Clip Studio infrastructure is installed. Video analysis engines are planned for later package updates."
    };
  }
  throw new Error("method_unavailable");
}

async function deactivate() {
  active = false;
}

module.exports = { activate, deactivate, handleRequest };
