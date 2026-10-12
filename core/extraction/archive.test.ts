import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { readOfficeParts, fingerprint, extractDocument } from './extract.ts';
const generated = Array.from({ length: 16 }, (_, i) => String.fromCharCode(65 + i)).join('');
test('ZIP extraction reads related text XML and skips all images and unrelated XML', async () => {
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('word/document.xml', new TextReader(`<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${generated}</w:t></w:r></w:p></w:body></w:document>`));
  await writer.add('word/_rels/document.xml.rels', new TextReader('<Relationships><Relationship Id="r1" Type="urn:/header" Target="header1.xml"/><Relationship Id="r2" Type="urn:/image" Target="media/image1.png"/></Relationships>'));
  await writer.add('word/header1.xml', new TextReader('<w:hdr xmlns:w="urn:w"/>'));
  await writer.add('word/media/image1.png', new TextReader(generated));
  await writer.add('unused.xml', new TextReader(generated));
  const parts = await readOfficeParts(await writer.close(), 'docx');
  assert.deepEqual([...parts.keys()], ['word/document.xml', 'word/_rels/document.xml.rels', 'word/header1.xml']);
});
// Speaker notes are not read (owner decision, 29 September 2026): the notes part is never even loaded from the archive.
test('ZIP extraction loads slide comments but never notes pages', async () => {
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  await writer.add('ppt/presentation.xml', new TextReader('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'));
  await writer.add('ppt/_rels/presentation.xml.rels', new TextReader(`<Relationships><Relationship Id="s" Type="${R}/slide" Target="slides/slide1.xml"/></Relationships>`));
  await writer.add('ppt/slides/slide1.xml', new TextReader('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'));
  await writer.add('ppt/slides/_rels/slide1.xml.rels', new TextReader(`<Relationships><Relationship Id="n" Type="${R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="c" Type="${R}/comments" Target="../comments/comment1.xml"/></Relationships>`));
  await writer.add('ppt/notesSlides/notesSlide1.xml', new TextReader(`<p:notes xmlns:p="urn:p">${generated}</p:notes>`));
  await writer.add('ppt/comments/comment1.xml', new TextReader('<p:cmLst xmlns:p="urn:p"/>'));
  const parts = await readOfficeParts(await writer.close(), 'pptx');
  assert.deepEqual([...parts.keys()], ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/comments/comment1.xml']);
});
test('fingerprints use the complete local bytes deterministically', async () => {
  const one = await fingerprint(new Blob([generated]));
  const two = await fingerprint(new Blob([generated]));
  const changed = await fingerprint(new Blob([generated + generated]));
  assert.equal(one.length, 64);
  assert.equal(one, two);
  assert.notEqual(one, changed);
});
test('unsupported files fail explicitly before parser execution', async () => {
  for(const name of ['type_a.bin','type_a.ppt','type_a.PPT'])await assert.rejects(extractDocument(new File([generated], name), {
    pdfWorkerUrl: '/pdf.worker.mjs', parserVersions: { pdf: '1', zip: '1', xml: '1' },
    pdfPolicy: { largeFontRatio: 1.2, maximumHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5, minimumHeadings: 2 },
  }), { code: 'E_UNSUPPORTED_FORMAT' });
});

test('blank DOCX and image-only PPTX fail even though parser adds page or slide markers', async () => {
 const options={pdfWorkerUrl:'/pdf.worker.mjs',parserVersions:{pdf:'1',zip:'1',xml:'1'},pdfPolicy:{largeFontRatio:1.2,maximumHeadingCharacters:120,topPageFraction:0.2,gapRatio:1.5,minimumHeadings:2}};
 const docx=new ZipWriter(new BlobWriter('application/zip'));
 await docx.add('word/document.xml',new TextReader('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:br w:type="page"/></w:r></w:p></w:body></w:document>'));
 await docx.add('docProps/core.xml',new TextReader('<cp:coreProperties xmlns:cp="urn:cp" xmlns:dc="urn:dc"><dc:title>Metadata only</dc:title></cp:coreProperties>'));
 await assert.rejects(extractDocument(new File([await docx.close()],'blank.docx'),options),{code:'E_NO_TEXT'});
 const pptx=new ZipWriter(new BlobWriter('application/zip'));
 await pptx.add('ppt/presentation.xml',new TextReader('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>'));
 await pptx.add('ppt/_rels/presentation.xml.rels',new TextReader('<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'));
 await pptx.add('ppt/slides/slide1.xml',new TextReader('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:pic/></p:spTree></p:cSld></p:sld>'));
 await pptx.add('ppt/media/image1.png',new TextReader(generated));
 await assert.rejects(extractDocument(new File([await pptx.close()],'imageonly.pptx'),options),{code:'E_NO_TEXT'});
});
