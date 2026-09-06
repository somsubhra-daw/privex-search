const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Cache (default 1 hour TTL)
const cacheTTL = parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10);
const searchCache = new NodeCache({ stdTTL: cacheTTL, checkperiod: 120 });

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());

// Serve Static Frontend Files
app.use(express.static(path.join(__dirname, 'public')));

// Client Rate Limiting (Default: 3 requests per 24 hours, with IP Whitelist)
const limiterWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '86400000', 10);
const limiterMax = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '3', 10);
const rawWhitelistedIps = process.env.WHITELISTED_IPS || '49.37.55.94,127.0.0.1,::1,::ffff:127.0.0.1';
const whitelistedIps = rawWhitelistedIps.split(',').map(ip => ip.trim()).filter(Boolean);

const apiLimiter = rateLimit({
  windowMs: limiterWindowMs,
  max: limiterMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = req.ip || (forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress);
    if (!clientIp) return false;
    return whitelistedIps.some(wIp => clientIp === wIp || clientIp.includes(wIp) || clientIp.endsWith(wIp));
  },
  message: {
    success: false,
    error: {
      code: 429,
      type: 'RATE_LIMIT_EXCEEDED',
      message: 'Daily search quota exceeded (maximum 3 requests per day). Whitelisted IPs have unlimited access.'
    }
  }
});

// Apply rate limiting to core search proxy endpoint
app.use('/api/search', apiLimiter);

// helper to detect active provider and keys
function getProviderInfo() {
  const envProvider = (process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
  const tavilyKey = process.env.TAVILY_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;
  const googleCx = process.env.GOOGLE_CX;
  const braveKey = process.env.BRAVE_API_KEY;
  const serpapiKey = process.env.SERPAPI_KEY;

  if (envProvider === 'tavily' && tavilyKey && tavilyKey.startsWith('tvly-')) {
    return { provider: 'tavily', isDemo: false, hasKey: true };
  } else if (envProvider === 'google' && googleKey && googleCx) {
    return { provider: 'google', isDemo: false, hasKey: true };
  } else if (envProvider === 'brave' && braveKey) {
    return { provider: 'brave', isDemo: false, hasKey: true };
  } else if (envProvider === 'serpapi' && serpapiKey) {
    return { provider: 'serpapi', isDemo: false, hasKey: true };
  } else if (tavilyKey && tavilyKey.startsWith('tvly-')) {
    return { provider: 'tavily', isDemo: false, hasKey: true };
  } else if (googleKey && googleCx) {
    return { provider: 'google', isDemo: false, hasKey: true };
  } else if (braveKey) {
    return { provider: 'brave', isDemo: false, hasKey: true };
  } else if (serpapiKey) {
    return { provider: 'serpapi', isDemo: false, hasKey: true };
  }

  return { provider: 'demo', isDemo: true, hasKey: false };
}

// GET /api/config Endpoint
app.get('/api/config', (req, res) => {
  const providerInfo = getProviderInfo();
  res.json({
    success: true,
    provider: providerInfo.provider,
    isDemo: providerInfo.isDemo,
    cacheTTL: cacheTTL
  });
});

// GET /api/suggest - Autocomplete Proxy Endpoint
app.get('/api/suggest', async (req, res) => {
  const q = req.query.q ? req.query.q.trim() : '';
  if (!q) {
    return res.json({ success: true, suggestions: [] });
  }

  const cacheKey = `suggest:${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    return res.json({ success: true, suggestions: cached, cached: true });
  }

  try {
    const url = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return res.json({ success: true, suggestions: [] });
    }

    const data = await response.json();
    const suggestions = Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 8) : [];
    
    searchCache.set(cacheKey, suggestions, 1800); // 30 mins TTL
    res.json({ success: true, suggestions, cached: false });
  } catch (error) {
    console.error('Autocomplete Error:', error.message);
    res.json({ success: true, suggestions: [] });
  }
});

// GET /api/search - Core Proxy Endpoint
app.get('/api/search', async (req, res) => {
  const startTime = Date.now();
  const q = req.query.q ? req.query.q.trim() : '';
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(20, Math.max(1, parseInt(req.query.num || '10', 10)));
  const safe = req.query.safe || 'active';
  const dateFilter = req.query.date || 'all';
  const searchDepth = req.query.depth || 'basic'; // 'basic' or 'advanced' for Tavily

  if (!q) {
    return res.status(400).json({
      success: false,
      error: {
        code: 400,
        type: 'INVALID_QUERY',
        message: 'Search query parameter "q" cannot be empty.'
      }
    });
  }

  const providerInfo = getProviderInfo();
  const cacheKey = `search:${providerInfo.provider}:${q.toLowerCase()}:${page}:${pageSize}:${safe}:${dateFilter}:${searchDepth}`;
  
  // Check Cache
  const cachedData = searchCache.get(cacheKey);
  if (cachedData) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({
      ...cachedData,
      cached: true,
      searchTime: ((Date.now() - startTime) / 1000).toFixed(3)
    });
  }

  try {
    let result;
    if (providerInfo.isDemo || providerInfo.provider === 'demo') {
      result = generateDemoResults(q, page, pageSize);
    } else if (providerInfo.provider === 'tavily') {
      result = await fetchTavilySearch(q, page, pageSize, searchDepth);
    } else if (providerInfo.provider === 'google') {
      result = await fetchGoogleCSE(q, page, pageSize, safe, dateFilter);
    } else if (providerInfo.provider === 'brave') {
      result = await fetchBraveSearch(q, page, pageSize, safe, dateFilter);
    } else if (providerInfo.provider === 'serpapi') {
      result = await fetchSerpApi(q, page, pageSize);
    } else {
      result = generateDemoResults(q, page, pageSize);
    }

    const searchTime = ((Date.now() - startTime) / 1000).toFixed(3);
    const responseData = {
      success: true,
      provider: providerInfo.provider,
      isDemo: providerInfo.isDemo,
      cached: false,
      query: q,
      page,
      pageSize,
      searchTime,
      ...result
    };

    // Cache successful responses
    searchCache.set(cacheKey, responseData);
    res.setHeader('X-Cache', 'MISS');
    return res.json(responseData);

  } catch (error) {
    console.error(`[Search API Error - ${providerInfo.provider}]:`, error.message);
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      provider: providerInfo.provider,
      error: {
        code: status,
        type: error.type || 'SEARCH_API_ERROR',
        message: error.message || 'An error occurred while communicating with the search provider.'
      }
    });
  }
});

// -------------------------------------------------------------
// Provider 1: Tavily Search API Integration
// -------------------------------------------------------------
async function fetchTavilySearch(q, page, pageSize, searchDepth = 'basic') {
  const apiKey = process.env.TAVILY_API_KEY;

  const requestBody = {
    api_key: apiKey,
    query: q,
    search_depth: searchDepth === 'advanced' ? 'advanced' : 'basic',
    include_answer: true,
    include_images: true,
    max_results: pageSize,
    topic: 'general'
  };

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();

  if (!response.ok) {
    const errorObj = new Error(data.detail || data.message || 'Tavily Search API request failed.');
    errorObj.statusCode = response.status;
    if (response.status === 429) {
      errorObj.type = 'RATE_LIMIT_EXCEEDED';
      errorObj.message = 'Tavily Search API quota limit or rate limit exceeded.';
    } else if (response.status === 401 || response.status === 403) {
      errorObj.type = 'AUTHENTICATION_ERROR';
      errorObj.message = 'Invalid Tavily API key in server .env file.';
    }
    throw errorObj;
  }

  const resultsList = data.results || [];
  const totalResults = resultsList.length;
  const formattedTotalResults = `${totalResults}+`;

  const items = resultsList.map(item => {
    let favicon = '';
    let displayUrl = item.url;
    try {
      const parsedUrl = new URL(item.url);
      const domain = parsedUrl.hostname;
      favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      displayUrl = `${domain} ${parsedUrl.pathname.replace(/\//g, ' › ')}`;
    } catch (e) {}

    return {
      title: item.title,
      link: item.url,
      displayUrl: displayUrl,
      snippet: item.content || '',
      score: item.score ? Math.round(item.score * 100) : null,
      publishedDate: item.published_date || null,
      favicon
    };
  });

  return {
    totalResults,
    formattedTotalResults,
    answer: data.answer || null,
    images: data.images || [],
    items
  };
}

// -------------------------------------------------------------
// Provider 2: Google Custom Search JSON API Integration
// -------------------------------------------------------------
async function fetchGoogleCSE(q, page, pageSize, safe, dateFilter) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;

  const startIndex = (page - 1) * pageSize + 1;
  const safeParam = safe === 'off' ? 'off' : 'active';
  const dateMap = { day: 'd1', week: 'w1', month: 'm1', year: 'y1' };
  const dateRestrict = dateMap[dateFilter] || '';

  let url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(q)}&start=${startIndex}&num=${pageSize}&safe=${safeParam}`;
  if (dateRestrict) {
    url += `&dateRestrict=${dateRestrict}`;
  }

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    const errorObj = new Error(data.error?.message || 'Google Custom Search API request failed.');
    errorObj.statusCode = response.status;
    if (response.status === 429 || data.error?.errors?.[0]?.reason === 'dailyLimitExceeded') {
      errorObj.type = 'RATE_LIMIT_EXCEEDED';
      errorObj.message = 'Google Custom Search daily free quota (100 queries/day) has been exceeded.';
    } else if (response.status === 400 || response.status === 403) {
      errorObj.type = 'AUTHENTICATION_ERROR';
      errorObj.message = 'Invalid Google API Key or Custom Search Engine ID (CX). Check your server .env file.';
    }
    throw errorObj;
  }

  const totalResults = parseInt(data.searchInformation?.totalResults || '0', 10);
  const formattedTotalResults = Number(totalResults).toLocaleString();

  const items = (data.items || []).map(item => {
    let favicon = '';
    try {
      const domain = new URL(item.link).hostname;
      favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch (e) {}

    return {
      title: item.title,
      link: item.link,
      displayUrl: item.formattedUrl || item.link,
      snippet: item.snippet,
      favicon
    };
  });

  return {
    totalResults,
    formattedTotalResults,
    answer: null,
    images: [],
    items
  };
}

// -------------------------------------------------------------
// Provider 3: Brave Search API Integration
// -------------------------------------------------------------
async function fetchBraveSearch(q, page, pageSize, safe, dateFilter) {
  const apiKey = process.env.BRAVE_API_KEY;
  const offset = page - 1;
  const safeParam = safe === 'off' ? 'off' : 'moderate';

  const dateMap = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
  const freshness = dateMap[dateFilter] || '';

  let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${pageSize}&offset=${offset}&safesearch=${safeParam}`;
  if (freshness) {
    url += `&freshness=${freshness}`;
  }

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const errorObj = new Error(data.message || 'Brave Search API request failed.');
    errorObj.statusCode = response.status;
    if (response.status === 429) {
      errorObj.type = 'RATE_LIMIT_EXCEEDED';
      errorObj.message = 'Brave Search API rate limit or monthly free quota exceeded.';
    } else if (response.status === 401 || response.status === 401) {
      errorObj.type = 'AUTHENTICATION_ERROR';
      errorObj.message = 'Invalid Brave Search API key in server .env file.';
    }
    throw errorObj;
  }

  const resultsList = data.web?.results || [];
  const totalResults = resultsList.length > 0 ? 1000 : 0;
  const formattedTotalResults = totalResults > 0 ? '1,000+' : '0';

  const items = resultsList.map(item => {
    let favicon = '';
    try {
      const domain = new URL(item.url).hostname;
      favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch (e) {}

    return {
      title: item.title,
      link: item.url,
      displayUrl: item.url,
      snippet: item.description || (item.extra_snippets ? item.extra_snippets.join(' ') : ''),
      favicon
    };
  });

  return {
    totalResults,
    formattedTotalResults,
    answer: null,
    images: [],
    items
  };
}

// -------------------------------------------------------------
// Provider 4: SerpAPI Integration
// -------------------------------------------------------------
async function fetchSerpApi(q, page, pageSize) {
  const apiKey = process.env.SERPAPI_KEY;
  const start = (page - 1) * pageSize;

  const url = `https://serpapi.com/search.json?api_key=${apiKey}&q=${encodeURIComponent(q)}&start=${start}&num=${pageSize}`;
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    const errorObj = new Error(data.error || 'SerpAPI request failed.');
    errorObj.statusCode = response.status || 500;
    if (data.error && data.error.includes('search limit')) {
      errorObj.type = 'RATE_LIMIT_EXCEEDED';
      errorObj.message = 'SerpAPI monthly search limit reached.';
    }
    throw errorObj;
  }

  const totalResults = parseInt(data.search_information?.total_results || '500', 10);
  const formattedTotalResults = Number(totalResults).toLocaleString();

  const items = (data.organic_results || []).map(item => {
    let favicon = '';
    try {
      const domain = new URL(item.link).hostname;
      favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    } catch (e) {}

    return {
      title: item.title,
      link: item.link,
      displayUrl: item.displayed_link || item.link,
      snippet: item.snippet || '',
      favicon
    };
  });

  return {
    totalResults,
    formattedTotalResults,
    answer: data.answer_box?.snippet || null,
    images: [],
    items
  };
}

// -------------------------------------------------------------
// Demo Mode / Fallback Results Generator (Enhanced with AI Answers)
// -------------------------------------------------------------
function generateDemoResults(q, page, pageSize) {
  const cleanQ = q.trim();
  const domainList = [
    { name: 'Wikipedia', host: 'en.wikipedia.org', path: '/wiki/' },
    { name: 'GitHub', host: 'github.com', path: '/topics/' },
    { name: 'MDN Web Docs', host: 'developer.mozilla.org', path: '/en-US/docs/Web/' },
    { name: 'Stack Overflow', host: 'stackoverflow.com', path: '/questions/' },
    { name: 'TechCrunch', host: 'techcrunch.com', path: '/tag/' },
    { name: 'Dev.to', host: 'dev.to', path: '/t/' },
    { name: 'Reddit', host: 'www.reddit.com', path: '/r/' },
    { name: 'Medium', host: 'medium.com', path: '/tag/' }
  ];

  const totalResults = 1250400;
  const formattedTotalResults = '1,250,400';
  const startIdx = (page - 1) * pageSize;

  // AI Direct Answer generation for demo mode
  const aiAnswers = {
    tavily: "Tavily Search API is an AI-first web search engine designed specifically for LLMs and AI agents. It provides real-time web grounding, comprehensive domain coverage, structured JSON outputs, and direct AI-generated summaries.",
    javascript: "JavaScript is a high-level, interpreted programming language that conforms to the ECMAScript specification. It features dynamic typing, prototype-based object-orientation, and first-class functions, serving as the core scripting technology of the World Wide Web.",
    python: "Python is an interpreted, high-level, general-purpose programming language created by Guido van Rossum. Its design philosophy emphasizes code readability with its notable use of significant whitespace.",
    ai: "Artificial Intelligence (AI) refers to the simulation of human intelligence in machines programmed to think, reason, and learn. Modern AI applications rely heavily on neural networks, large language models (LLMs), and machine learning frameworks."
  };

  let matchedAnswerKey = Object.keys(aiAnswers).find(k => cleanQ.toLowerCase().includes(k));
  let demoAnswer = matchedAnswerKey 
    ? aiAnswers[matchedAnswerKey] 
    : `PriveX Overview: Here is a synthesized summary for "${cleanQ}". Web search results indicate key documentation, tutorials, and community guides covering fundamentals, implementation examples, and modern best practices.`;

  // Sample image previews for demo mode
  const demoImages = [
    'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=400&q=80',
    'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=400&q=80',
    'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=400&q=80',
    'https://images.unsplash.com/photo-1618401471353-b98afee0b2eb?w=400&q=80'
  ];

  const items = [];
  for (let i = 0; i < pageSize; i++) {
    const itemNum = startIdx + i + 1;
    const dom = domainList[i % domainList.length];
    const slug = cleanQ.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const url = `https://${dom.host}${dom.path}${slug}-${itemNum}`;

    const CapitalizedQ = cleanQ.charAt(0).toUpperCase() + cleanQ.slice(1);
    const itemTitle = i === 0 
      ? `${CapitalizedQ} - Complete Developer Reference & Overview` 
      : `${CapitalizedQ}: Guide, Code Examples & Best Practices (#${itemNum})`;

    const itemSnippet = `Explore detailed insights, documentation, and tutorials for ${cleanQ}. Learn core concepts, standard patterns, real-world examples, and modern integrations.`;

    items.push({
      title: itemTitle,
      link: url,
      displayUrl: `${dom.host} › ${slug}`,
      snippet: itemSnippet,
      score: Math.max(70, 99 - i * 3),
      favicon: `https://www.google.com/s2/favicons?domain=${dom.host}&sz=32`
    });
  }

  return {
    totalResults,
    formattedTotalResults,
    answer: demoAnswer,
    images: demoImages,
    items
  };
}

// Start Server
app.listen(PORT, () => {
  const providerInfo = getProviderInfo();
  console.log(`\n==================================================`);
  console.log(` 🚀 PriveX Search Engine Backend Engine Running!`);
  console.log(` 🌐 Server URL: http://localhost:${PORT}`);
  console.log(` 🔍 Active Provider: ${providerInfo.provider.toUpperCase()} ${providerInfo.isDemo ? '(Demo / Fallback Mode)' : '(Live API Key Configured)'}`);
  console.log(` ⚡ Quota Cache TTL: ${cacheTTL}s | Rate Limit: ${limiterMax} req / 15m`);
  console.log(`==================================================\n`);
});
