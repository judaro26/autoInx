project = 'autoInx Knowledge Base'
copyright = '2025, autoInx'
author = 'Admin Team'

# Add 'myst_parser' to extensions to support .md files
extensions = [
    'myst_parser',
    'sphinx_rtd_theme',
]

# Use the professional Read the Docs theme
html_theme = "sphinx_rtd_theme"

# Define where your source files are
source_suffix = {
    '.rst': 'restructuredtext',
    '.md': 'markdown',
}
