import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import org.apache.lucene.analysis.Analyzer;
import org.apache.lucene.analysis.CharArraySet;
import org.apache.lucene.analysis.LowerCaseFilter;
import org.apache.lucene.analysis.StopFilter;
import org.apache.lucene.analysis.TokenStream;
import org.apache.lucene.analysis.Tokenizer;
import org.apache.lucene.analysis.miscellaneous.ASCIIFoldingFilter;
import org.apache.lucene.analysis.standard.StandardTokenizer;
import org.apache.lucene.analysis.tokenattributes.CharTermAttribute;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.StoredField;
import org.apache.lucene.document.StringField;
import org.apache.lucene.document.TextField;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.IndexWriter;
import org.apache.lucene.index.IndexWriterConfig;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.BoostQuery;
import org.apache.lucene.search.FuzzyQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.MatchAllDocsQuery;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.search.TopDocs;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.apache.lucene.store.Directory;

public class LuceneBench {
  private static final FieldSpec[] FIELDS = new FieldSpec[] {
    new FieldSpec("title", 4.5f),
    new FieldSpec("authors", 3.0f),
    new FieldSpec("advisors", 2.4f),
    new FieldSpec("subjects", 2.2f),
    new FieldSpec("discipline", 1.8f),
    new FieldSpec("abstract", 1.0f),
    new FieldSpec("source_name", 0.4f),
    new FieldSpec("year", 1.2f),
  };

  private static final CharArraySet STOPWORDS = new CharArraySet(List.of(
    "a", "au", "aux", "avec", "ce", "ces", "dans", "de", "des", "du", "elle", "en",
    "et", "eux", "il", "ils", "je", "la", "le", "les", "leur", "leurs", "lui", "ma",
    "mais", "me", "mes", "moi", "mon", "ne", "nos", "notre", "nous", "ou", "par",
    "pas", "pour", "qu", "que", "qui", "sa", "se", "ses", "son", "sur", "ta", "te",
    "tes", "toi", "ton", "tu", "un", "une", "vos", "votre", "vous", "the", "and",
    "for", "with", "from", "that", "this", "these", "those", "into", "onto", "over",
    "under", "between", "within", "without", "about", "after", "before", "than", "then",
    "are", "was", "were", "been", "being", "have", "has", "had", "not", "all", "any",
    "can", "could", "should", "would"
  ), true);

  private record FieldSpec(String name, float boost) {}

  private static final class FoldedAnalyzer extends Analyzer {
    @Override
    protected TokenStreamComponents createComponents(String fieldName) {
      Tokenizer source = new StandardTokenizer();
      TokenStream tokens = new LowerCaseFilter(source);
      tokens = new ASCIIFoldingFilter(tokens);
      tokens = new StopFilter(tokens, STOPWORDS);
      return new TokenStreamComponents(source, tokens);
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length < 1) {
      throw new IllegalArgumentException("Usage: LuceneBench <data/theses.db> [size]");
    }
    String dbPath = args[0];
    int size = args.length >= 2 ? Integer.parseInt(args[1]) : 10;

    try (Analyzer analyzer = new FoldedAnalyzer(); Directory directory = new ByteBuffersDirectory()) {
      buildIndex(dbPath, analyzer, directory);
      try (DirectoryReader reader = DirectoryReader.open(directory)) {
        IndexSearcher searcher = new IndexSearcher(reader);
        System.out.println("READY");
        System.out.flush();

        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = input.readLine()) != null) {
          String query = new String(Base64.getDecoder().decode(line), StandardCharsets.UTF_8);
          System.out.println(search(searcher, analyzer, query, size));
          System.out.flush();
        }
      }
    }
  }

  private static void buildIndex(String dbPath, Analyzer analyzer, Directory directory) throws Exception {
    IndexWriterConfig config = new IndexWriterConfig(analyzer);
    config.setRAMBufferSizeMB(512);
    try (IndexWriter writer = new IndexWriter(directory, config);
         Connection db = DriverManager.getConnection("jdbc:sqlite:" + dbPath);
         Statement stmt = db.createStatement();
         ResultSet rows = stmt.executeQuery(
           "SELECT rowid AS id, title, authors, advisors, abstract, subjects, year, " +
           "type, source_name, discipline, url FROM theses ORDER BY rowid"
         )) {
      while (rows.next()) {
        Document doc = new Document();
        doc.add(new StringField("id", rows.getString("id"), Field.Store.YES));
        doc.add(new StoredField("title_stored", value(rows, "title")));
        doc.add(new StoredField("url_stored", value(rows, "url")));
        for (FieldSpec field : FIELDS) {
          String value = field.name().equals("year") ? value(rows, "year") : value(rows, field.name());
          if (!value.isBlank()) doc.add(new TextField(field.name(), value, Field.Store.NO));
        }
        writer.addDocument(doc);
      }
    }
  }

  private static String search(IndexSearcher searcher, Analyzer analyzer, String rawQuery, int size) throws Exception {
    Query query = buildQuery(analyzer, rawQuery);
    TopDocs docs = searcher.search(query, size);
    StringBuilder out = new StringBuilder();
    out.append("{\"total\":").append(docs.totalHits.value).append(",\"results\":[");
    for (int i = 0; i < docs.scoreDocs.length; i++) {
      if (i > 0) out.append(',');
      ScoreDoc hit = docs.scoreDocs[i];
      Document doc = searcher.storedFields().document(hit.doc);
      out.append("{\"id\":\"").append(json(doc.get("id"))).append("\",");
      out.append("\"title\":\"").append(json(doc.get("title_stored"))).append("\",");
      out.append("\"url\":\"").append(json(doc.get("url_stored"))).append("\"}");
    }
    out.append("]}");
    return out.toString();
  }

  private static Query buildQuery(Analyzer analyzer, String rawQuery) throws IOException {
    List<String> tokens = analyze(analyzer, rawQuery);
    if (tokens.isEmpty()) return new MatchAllDocsQuery();

    BooleanQuery.Builder outer = new BooleanQuery.Builder();
    int minShouldMatch = tokens.size() <= 4 ? tokens.size() : tokens.size() - 1;
    for (String token : tokens) {
      BooleanQuery.Builder anyField = new BooleanQuery.Builder();
      for (FieldSpec field : FIELDS) {
        Term term = new Term(field.name(), token);
        anyField.add(new BoostQuery(new TermQuery(term), field.boost() * 2.0f), BooleanClause.Occur.SHOULD);
        if (token.length() >= 5) {
          int edits = token.length() >= 8 ? 2 : 1;
          Query fuzzy = new FuzzyQuery(term, edits, 1, 64, true);
          anyField.add(new BoostQuery(fuzzy, field.boost() * 0.55f), BooleanClause.Occur.SHOULD);
        }
      }
      outer.add(anyField.build(), tokens.size() <= 4 ? BooleanClause.Occur.MUST : BooleanClause.Occur.SHOULD);
    }
    BooleanQuery query = outer.build();
    if (tokens.size() > 4) {
      BooleanQuery.Builder builder = new BooleanQuery.Builder();
      for (BooleanClause clause : query.clauses()) builder.add(clause);
      builder.setMinimumNumberShouldMatch(minShouldMatch);
      return builder.build();
    }
    return query;
  }

  private static List<String> analyze(Analyzer analyzer, String text) throws IOException {
    List<String> tokens = new ArrayList<>();
    try (TokenStream stream = analyzer.tokenStream("q", text)) {
      CharTermAttribute term = stream.addAttribute(CharTermAttribute.class);
      stream.reset();
      while (stream.incrementToken()) {
        String token = term.toString();
        if (token.length() >= 2) tokens.add(token);
      }
      stream.end();
    }
    return tokens;
  }

  private static String value(ResultSet rows, String field) throws Exception {
    String value = rows.getString(field);
    return value == null ? "" : value;
  }

  private static String json(String value) {
    if (value == null) return "";
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '\\' -> out.append("\\\\");
        case '"' -> out.append("\\\"");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    return out.toString();
  }
}
