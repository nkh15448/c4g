# Cats4Ghana Lesson Plan Finder

A search page for every Cats4Ghana lesson plan. It reads the text *inside* each PDF, so tutors can find a plan by what it covers even when the file is called "Week 6". Small typos still match ("photosynthsis" finds photosynthesis), and each result links straight to the page where the match is.

**Site:** `https://<owner>.github.io/<repo>/` (fill in once it's set up)

## Adding a lesson plan

You need a GitHub account with access to this repo. Ask whoever manages it to add you.

1. Open the [`lesson-plans`](lesson-plans) folder, then the subject, then the grade (for example `math` → `grade-3`).
2. Click **Add file → Upload files**.
3. Drag in one or more PDFs and click **Commit changes**.

That's all. About a minute later the plan is searchable on the site. To watch progress, open the **Actions** tab; a green check means it's live.

**The grade folder doesn't exist yet?** On the upload page, drag in a *folder* named for the grade (like `grade-7`) with the PDFs inside it. GitHub keeps the folder.

**Tips**

- PDFs exported from Google Docs, Slides, Canva or Word work best, because their text can be read directly. Scanned or photographed pages are run through OCR automatically, but that's less reliable.
- The file name is shown as the plan's title, so a descriptive name still helps (`Week 6 - Fractions and Time.pdf`), but it isn't required to be found.
- To replace a plan, upload a new version with the same name into the same folder. To remove one, open the file and choose **⋯ → Delete file**.

## Folder layout

```
lesson-plans/
  math/
    grade-3/
      Week 6 Lesson Plan.pdf
  science/
  literacy/
```

The first folder is the subject and the second is the grade. These become the filters on the site, shown as "Math", "Grade 3" and so on (`jhs-1` shows as "JHS 1"). Deeper folders such as `math/grade-3/unit-2/` are fine, and their names are searchable too.

## One-time setup (repo owner)

1. Push this folder to a public GitHub repo.
2. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Go to **Settings → Collaborators** (or the org's teams) and give each lesson plan maker **Write** access.
4. Push any change, or open **Actions → Build and deploy → Run workflow**. The site appears at `https://<owner>.github.io/<repo>/`.

## How it works

- `scripts/build.mjs` reads the text from every PDF with [pdf.js](https://mozilla.github.io/pdf.js/), OCRs scanned pages with Tesseract when it's installed, builds a [MiniSearch](https://lucaong.github.io/minisearch/) index and writes the finished site to `dist/`.
- `site/` is the page itself: plain HTML, CSS and JavaScript. Searching runs in the tutor's browser, so there's no server or database to look after.
- `.github/workflows/deploy.yml` runs the build and publishes to GitHub Pages on every push to `main`. Extracted text is cached by file contents, so each run only reads new or changed PDFs.

## Running it locally

```bash
npm install
npm run dev
```

This builds the site and serves it at http://localhost:4500. To index some other folder of PDFs (handy for testing), run `npm run build -- --plans <folder>`.

## Good to know

- The site is public: anyone with the link can search and open the plans. Search engines are asked not to list it.
- GitHub's web upload takes files up to 25 MB each. A Pages site can be up to 1 GB, which is room for a few thousand typical lesson plan PDFs.
