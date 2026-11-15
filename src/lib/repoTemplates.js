/**
 * v1.2.0-multi — a small, curated set of starter file sets for the
 * 📋 Template option on New Repo's confirm screen. Deliberately NOT
 * GitHub's own "template repository" mechanism (generate-from-template)
 * — that would require the person to already own or have access to a
 * template repo, which most people setting up their first project don't.
 * These are just a handful of genuinely useful starting points, committed
 * as a normal multi-file commit right after repo creation via the same
 * github.commitMultipleFiles() every upload already uses.
 */
const TEMPLATES = {
  node: {
    label: 'Node.js',
    files: [
      { path: 'package.json', content: JSON.stringify({ name: '{{name}}', version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2) + '\n' },
      { path: 'index.js', content: "console.log('Hello from {{name}}');\n" },
      { path: '.gitignore', content: 'node_modules/\n.env\n' },
    ],
  },
  python: {
    label: 'Python',
    files: [
      { path: 'main.py', content: "def main():\n    print('Hello from {{name}}')\n\n\nif __name__ == '__main__':\n    main()\n" },
      { path: 'requirements.txt', content: '' },
      { path: '.gitignore', content: '__pycache__/\n*.pyc\n.venv/\n' },
    ],
  },
  'static-html': {
    label: 'Static HTML',
    files: [
      { path: 'index.html', content: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>{{name}}</title>\n</head>\n<body>\n  <h1>{{name}}</h1>\n</body>\n</html>\n' },
      { path: 'style.css', content: 'body {\n  font-family: sans-serif;\n}\n' },
    ],
  },
};

/** Returns the file set for a template key with {{name}} substituted for
 * the actual repo name — null if the key doesn't match a known template
 * (including the 'none' choice, which is a real, expected outcome, not
 * an error). */
function getTemplateFiles(templateKey, repoName) {
  const template = TEMPLATES[templateKey];
  if (!template) return null;
  return template.files.map((f) => ({ path: f.path, content: f.content.replace(/\{\{name\}\}/g, repoName) }));
}

function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label }));
}

module.exports = { getTemplateFiles, listTemplates };
