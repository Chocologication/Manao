import { ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/utils';

interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

interface TerminalSearchBarProps {
  isOpen: boolean;
  onClose: () => void;
  onFindNext: (term: string, options?: SearchOptions) => boolean;
  onFindPrevious: (term: string, options?: SearchOptions) => boolean;
  onClearSearch: () => void;
  theme?: {
    background?: string;
    foreground?: string;
  };
}

export interface TerminalSearchBarRef {
  focus: () => void;
}

export const TerminalSearchBar = forwardRef<TerminalSearchBarRef, TerminalSearchBarProps>(
  function TerminalSearchBar(
    { isOpen, onClose, onFindNext, onFindPrevious, onClearSearch, theme },
    ref
  ) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [regex, setRegex] = useState(false);
    const [hasResults, setHasResults] = useState<boolean | null>(null);

    useImperativeHandle(ref, () => ({
      focus: () => {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    }));

    useEffect(() => {
      if (isOpen) {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }, [isOpen]);

    useEffect(() => {
      if (!isOpen) {
        onClearSearch();
        setHasResults(null);
      }
    }, [isOpen, onClearSearch]);

    const handleSearch = useCallback(
      (direction: 'next' | 'prev') => {
        if (!searchTerm) {
          setHasResults(null);
          return;
        }
        const options = { caseSensitive, wholeWord, regex };
        const found =
          direction === 'next'
            ? onFindNext(searchTerm, options)
            : onFindPrevious(searchTerm, options);
        setHasResults(found);
      },
      [searchTerm, caseSensitive, wholeWord, regex, onFindNext, onFindPrevious]
    );

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSearch(e.shiftKey ? 'prev' : 'next');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      },
      [handleSearch, onClose]
    );

    const handleInputChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setSearchTerm(value);
        if (value) {
          const found = onFindNext(value, { caseSensitive, wholeWord, regex });
          setHasResults(found);
        } else {
          onClearSearch();
          setHasResults(null);
        }
      },
      [caseSensitive, wholeWord, regex, onFindNext, onClearSearch]
    );

    if (!isOpen) return null;

    const bgColor = theme?.background ?? '#1e1e1e';
    const fgColor = theme?.foreground ?? '#d4d4d4';

    return (
      <div
        className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border px-2 py-1 shadow-lg"
        style={{
          backgroundColor: bgColor,
          borderColor: `${fgColor}30`,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={searchTerm}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Search..."
          className={cn(
            'w-40 bg-transparent text-sm outline-none placeholder:opacity-50',
            hasResults === false && searchTerm && 'text-red-400'
          )}
          style={{ color: fgColor }}
        />

        <button
          type="button"
          onClick={() => setCaseSensitive(!caseSensitive)}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded text-xs font-bold transition-colors',
            caseSensitive ? 'bg-white/20' : 'opacity-50 hover:opacity-100'
          )}
          style={{ color: fgColor }}
          title="Case Sensitive (Aa)"
        >
          Aa
        </button>

        <button
          type="button"
          onClick={() => setWholeWord(!wholeWord)}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded text-xs font-bold transition-colors',
            wholeWord ? 'bg-white/20' : 'opacity-50 hover:opacity-100'
          )}
          style={{ color: fgColor }}
          title="Whole Word"
        >
          W
        </button>

        <button
          type="button"
          onClick={() => setRegex(!regex)}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded text-xs font-bold transition-colors',
            regex ? 'bg-white/20' : 'opacity-50 hover:opacity-100'
          )}
          style={{ color: fgColor }}
          title="Regular Expression"
        >
          .*
        </button>

        <div className="mx-1 h-4 w-px" style={{ backgroundColor: `${fgColor}30` }} />

        <button
          type="button"
          onClick={() => handleSearch('prev')}
          className="flex h-6 w-6 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100"
          style={{ color: fgColor }}
          title="Previous (Shift+Enter)"
        >
          <ChevronUp className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => handleSearch('next')}
          className="flex h-6 w-6 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100"
          style={{ color: fgColor }}
          title="Next (Enter)"
        >
          <ChevronDown className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100"
          style={{ color: fgColor }}
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
);
