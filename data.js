(async () => {
  try {
    const parts = ["data-001.txt","data-002.txt","data-003.txt","data-004.txt"];
    const chunks = await Promise.all(parts.map(async (file) => {
      const response = await fetch(file);
      if (!response.ok) throw new Error(`Falha ao carregar ${file}`);
      return response.text();
    }));
    Function(chunks.join(""))();
    const script = document.createElement("script");
    script.src = "app.js";
    document.body.appendChild(script);
  } catch (error) {
    document.body.innerHTML = '<main style="font-family:system-ui;padding:2rem"><h1>Não foi possível carregar o Rota PCPR.</h1><p>Atualize a página em alguns instantes.</p></main>';
    console.error(error);
  }
})();
