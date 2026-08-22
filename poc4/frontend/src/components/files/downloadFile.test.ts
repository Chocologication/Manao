import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fileApi from '../../api/fileApi';
import { parseProjectRelativePath } from '../../features/files/pathPolicy';
import { downloadFile } from './downloadFile';

const PROJECT_ID = 'prj-alice-notebook';
const LOGO = parseProjectRelativePath('assets/logo.png');

function ensureObjectUrlFns(): void {
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:http://localhost/mock',
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
}

beforeEach(() => {
  ensureObjectUrlFns();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('downloadFile', () => {
  it('uses the authenticated blob API, clicks a temporary anchor, and revokes the object URL', async () => {
    const blob = new Blob(['png-bytes']);
    const objectUrl = 'blob:http://localhost/download-1';
    const order: string[] = [];
    vi.spyOn(fileApi, 'downloadFileBlob').mockResolvedValue({ blob, filename: 'logo.png' });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      order.push('create');
      return objectUrl;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      order.push('revoke');
    });
    const click = vi.fn(() => {
      order.push('click');
    });
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = realCreateElement(tagName);
      if (tagName === 'a') {
        element.click = click;
      }
      return element;
    });

    await downloadFile(PROJECT_ID, LOGO, 'logo.png');

    expect(fileApi.downloadFileBlob).toHaveBeenCalledWith(PROJECT_ID, LOGO, 'logo.png');
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['create', 'click', 'revoke']);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(objectUrl);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('revokes the object URL in finally when clicking the anchor throws', async () => {
    const blob = new Blob(['png-bytes']);
    const objectUrl = 'blob:http://localhost/download-2';
    vi.spyOn(fileApi, 'downloadFileBlob').mockResolvedValue({ blob, filename: 'logo.png' });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(objectUrl);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = realCreateElement(tagName);
      if (tagName === 'a') {
        element.click = () => {
          throw new Error('click failed');
        };
      }
      return element;
    });

    await expect(downloadFile(PROJECT_ID, LOGO, 'logo.png')).rejects.toThrow('click failed');

    expect(revoke).toHaveBeenCalledWith(objectUrl);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('does not put a JWT into a download URL', async () => {
    const blob = new Blob(['png-bytes']);
    vi.spyOn(fileApi, 'downloadFileBlob').mockResolvedValue({ blob, filename: 'logo.png' });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/download-3');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await downloadFile(PROJECT_ID, LOGO, 'logo.png');

    const blobUrl = vi.mocked(URL.createObjectURL).mock.results[0]?.value as string;
    expect(blobUrl).not.toContain('Bearer');
    expect(blobUrl).not.toContain('access-token');
    expect(String(vi.mocked(fileApi.downloadFileBlob).mock.calls[0])).not.toContain('access-token');
  });
});
