import DOMPurify from 'dompurify'
import { marked } from 'marked'

// Agent output is untrusted. Keep the vocabulary small before TinyBubble's x-html binding.
const allowedTags = [
    'p', 'br', 'strong', 'em', 'del', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
]

export function renderAssistantMarkdown(text) {
    if (!text) return ''
    return DOMPurify.sanitize(marked.parse(String(text), { gfm: true, breaks: true }), {
        ALLOWED_TAGS: allowedTags,
        ALLOWED_ATTR: ['href', 'title'],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
    })
}
