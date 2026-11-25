<p align="center">
  <img src="logo.png" alt="MDpedia logo" width="200">
</p>

# MDpedia

**A private, self-hosted wiki for your Markdown notes, with search that actually finds things.**

MDpedia turns a folder of Markdown files into a clean, searchable knowledge base that you own and run yourself. Write in plain text, upload your files, and let an optional AI assistant do the tedious filing: it reads each document and suggests a summary, keywords and categories. You stay in control and review everything before readers see it.

## Why MDpedia?

**Your files stay yours.**
Every document is a plain `.md` file on your own disk. There is no proprietary format and no lock-in. If you ever stop using MDpedia, your content is already in a format every tool understands.

**Nothing is published by accident.**
New uploads are private until an admin approves them. The AI only makes suggestions. It never publishes anything, never creates categories on its own, and is only allowed to add to your text, never rewrite it.

**Readers get a fast, simple site.**
Visitors need no account and see no clutter. They search, browse by category, and follow links between documents. Search does not call any outside AI service while a reader is using it, so it is quick, private and costs nothing per search.

**Great for technical and mathematical writing.**
Equations written in LaTeX (`$E = mc^2$`) display beautifully, and code blocks are syntax highlighted.

**AI that helps, but is optional.**
Connect any OpenAI-compatible AI service and MDpedia will prepare keywords, summaries and category suggestions for you. Leave it off and everything still works; you simply fill in the details by hand. Daily call limits and an automatic safety switch keep costs and surprises in check.

**Built to be safe and low-maintenance.**
Built-in backups, health checks, activity logs and automatic clean-up keep it tidy. Content is sanitized before display, admin actions are logged, and login attempts are rate limited.

## What you can do with it

| For readers | For administrators |
|---|---|
| Search across titles, summaries, keywords and full text | Upload one document or hundreds at once |
| Browse documents by category, like folders | Review AI suggestions and approve with one click |
| Jump between related documents with `[[wiki links]]` | Organise documents in a category tree (up to three levels) |
| See "What links here" on every page | Replace a document and review a side-by-side comparison before it goes live |
| Read math and code beautifully formatted | Ask the AI to improve many documents at once, and approve each change |
| | See what people search for and what they fail to find |
| | Spot broken links, damaged files and failed jobs from one dashboard |

## Features at a glance

- **Markdown with math and code**: tables, task lists, LaTeX equations and highlighted code
- **Smart search**: weighted keyword search with phrase support and automatic fallback to partial matches
- **Wiki-style linking** between documents, with broken-link detection
- **AI-assisted metadata** (optional): summaries, keywords, synonyms, questions and category suggestions
- **Review and approval workflow** so you decide what goes live
- **Bulk import and bulk AI editing** with a preview of the cost before anything runs
- **Safe updates**: readers keep seeing the old version until you approve the new one
- **Files are the source of truth**: edit a file directly and MDpedia notices and keeps up
- **Backups, health monitoring and automatic housekeeping**
- **Experimental semantic (vector) search** for administrators, running entirely on your own machine

## Who is it for?

- Individuals and small teams who want a personal or internal knowledge base
- Anyone who writes in Markdown and wants a proper home for it
- Students, engineers and researchers with notes full of formulas and code
- People who would rather host their own data than hand it to a cloud service

## Getting started

MDpedia runs on any small Linux server you control. Setup takes a handful of commands, and a first document can be live within minutes.

Installation, configuration, maintenance and architecture are all covered in the **[technical specification (SPEC.md)](SPEC.md)**.

## Status

MDpedia is feature-complete for its first version. Planned improvements, such as images, version history and HTTPS, are on the maintainer's list.
