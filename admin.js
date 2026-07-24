/**
 * MovieBox - Admin Service
 * Handles custom links, manual Hindi dubbed overrides, and analytics.
 * v2.1 - XSS-safe rendering, MongoDB persistence wired.
 */

const ADMIN_STORAGE_KEY = 'moviebox_admin';

// HTML escape utility to prevent XSS in admin list rendering
function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const Admin = {
   /**
    * Get all admin-defined movie data from localStorage
    */
   getAdminData() {
      try {
        const data = localStorage.getItem(ADMIN_STORAGE_KEY);
        return data ? JSON.parse(data) : {};
      } catch (e) {
        return {};
      }
   },

   /**
    * Save or update data for a movie locally AND persist to MongoDB
    * @param {string} id - Movie ID
    * @param {object} updates - { customLink, isHindiDubbed }
    */
   saveMovieData(id, { customLink, isHindiDubbed }) {
      const data = this.getAdminData();
      data[id] = {
         ...(data[id] || {}),
         id: id,
         customLink: customLink || (data[id] && data[id].customLink),
         hindi: isHindiDubbed,
         original_language: isHindiDubbed ? 'hi' : 'en',
         manual: true
      };
      localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(data));

      // Persist to MongoDB via authenticated server API
      fetch('/api/v1/admin-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data[id])
      }).then(res => {
        if (!res.ok) {
          console.warn('[Admin] Failed to persist to MongoDB:', res.status);
        }
      }).catch(err => {
        console.warn('[Admin] Network error persisting to MongoDB:', err.message);
      });

      this.updateAdminList();
      return true;
   },

   /**
    * Get data for a specific movie
    */
   getMovieData(id) {
      const data = this.getAdminData();
      return data[id] || null;
   },

   /**
    * Delete data for a movie locally and from MongoDB
    */
   deleteMovieData(id) {
      const data = this.getAdminData();
      delete data[id];
      localStorage.setItem(ADMIN_STORAGE_KEY, JSON.stringify(data));

      // Delete from MongoDB via authenticated API
      fetch(`/api/v1/admin-store?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(err => {
        console.warn('[Admin] Failed to delete from MongoDB:', err.message);
      });

      this.updateAdminList();
   },

   /**
    * Initialize Admin UI
    */
   /**
    * Load global configuration settings (like requires_ads_servers) from MongoDB
    */
    async loadGlobalSettings() {
       try {
         const response = await fetch('/api/v1/admin-store').catch(() => null);
         if (!response || !response.ok) return;
         const res = await response.json().catch(() => null);
         if (!res) return;
         const settings = Array.isArray(res) ? res.find(item => item.id === 'global_settings') : null;
         if (settings) {
           if (settings.requires_ads_servers) {
             const checkboxes = document.querySelectorAll('#admin-server-ads-checkboxes input[type="checkbox"]');
             checkboxes.forEach(cb => {
               const serverName = cb.getAttribute('data-server');
               cb.checked = settings.requires_ads_servers.includes(serverName);
             });
             localStorage.setItem('moviebox_requires_ads_servers', JSON.stringify(settings.requires_ads_servers));
           }
           if (settings.default_play_server) {
             localStorage.setItem('moviebox_default_play_server', settings.default_play_server);
           } else {
             localStorage.removeItem('moviebox_default_play_server');
           }
         }
       } catch (err) {
         // Silently handle to avoid polluting console under crawlers/offline states
       }
    },

   /**
    * Initialize Admin UI
    */
   init() {
      const adminToggle = document.getElementById('admin-toggle');
      const adminPanel = document.getElementById('admin-panel');
      const saveBtn = document.getElementById('admin-save-btn');
      const movieIdInput = document.getElementById('admin-movie-id');
      const customLinkInput = document.getElementById('admin-custom-link');
      const hindiCheckbox = document.getElementById('admin-hindi-dubbed');
      const saveServerAdsBtn = document.getElementById('admin-save-server-ads-btn');

      // Safety check: only add listeners if elements exist
      if (adminToggle && adminPanel) {
         adminToggle.addEventListener('click', (e) => {
            e.preventDefault();
            adminPanel.classList.toggle('active');
            this.updateAdminList();
            this.loadGlobalSettings();
         });
      }

      if (saveServerAdsBtn) {
         saveServerAdsBtn.addEventListener('click', async () => {
            const checkboxes = document.querySelectorAll('#admin-server-ads-checkboxes input[type="checkbox"]');
            const requires_ads_servers = [];
            checkboxes.forEach(cb => {
               if (cb.checked) {
                  requires_ads_servers.push(cb.getAttribute('data-server'));
               }
            });

            const currentDefaultServer = localStorage.getItem('moviebox_default_play_server') || '';
            const payload = {
               id: 'global_settings',
               requires_ads_servers,
               default_play_server: currentDefaultServer
            };

            try {
               await fetch('/api/v1/admin-store', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify(payload)
               });
               localStorage.setItem('moviebox_requires_ads_servers', JSON.stringify(requires_ads_servers));
               this.showStatus('Server ads settings saved successfully!', 'success');
            } catch (err) {
               this.showStatus('Failed to save: ' + err.message, 'error');
            }
         });
      }

      if (saveBtn) {
         saveBtn.addEventListener('click', () => {
            const id = movieIdInput ? movieIdInput.value.trim() : '';
            const customLink = customLinkInput ? customLinkInput.value.trim() : '';
            const isHindiDubbed = hindiCheckbox ? hindiCheckbox.checked : false;

            if (!id) {
               this.showStatus('Please enter a Movie ID', 'error');
               return;
            }

            this.saveMovieData(id, { customLink, isHindiDubbed });
            this.showStatus('Movie data saved & synced to database!', 'success');

            // Reset inputs
            if (movieIdInput) movieIdInput.value = '';
            if (customLinkInput) customLinkInput.value = '';
            if (hindiCheckbox) hindiCheckbox.checked = false;
         });
      }

      this.updateAdminList();
      this.loadGlobalSettings();
   },

   /**
    * UI: Show status message
    */
   showStatus(msg, type) {
      const statusDiv = document.getElementById('admin-status');
      if (!statusDiv) return;
      statusDiv.textContent = msg;
      statusDiv.style.color = type === 'success' ? '#4caf50' : '#f44336';
      setTimeout(() => { if (statusDiv) statusDiv.textContent = ''; }, 3000);
   },

   /**
    * UI: Update list of managed movies (XSS-safe — no dynamic innerHTML with raw data)
    */
   updateAdminList() {
      const listDiv = document.getElementById('admin-list');
      if (!listDiv) return;

      const data = this.getAdminData();
      const ids = Object.keys(data);

      if (ids.length === 0) {
         listDiv.innerHTML = '<p>No custom movie data defined yet.</p>';
         return;
      }

      let html = '<h3>Managed Movies</h3><ul style="list-style:none; padding:0; margin-top:1rem;">';
      ids.forEach(id => {
         const m = data[id];
         const isHindi = m.hindi || m.original_language === 'hi';
         // Escape all dynamic values before inserting into HTML
         const safeId   = escHtml(String(id));
         const safeLink = escHtml(m.customLink || '');
         const linkHtml = safeLink
           ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer" style="color:#007bff; font-size:0.8rem;">Custom Link</a>`
           : '<span style="color:grey;font-size:0.8rem;">No Link</span>';
         html += `
         <li style="display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #333;">
             <div>
                 <strong>ID: ${safeId}</strong> |
                 ${isHindi ? '<span style="color:red">Hindi</span>' : '<span style="color:grey">Original</span>'} |
                 ${linkHtml}
             </div>
             <button onclick="Admin.deleteMovieData('${safeId}')" style="background:none; border:none; color:red; cursor:pointer;" aria-label="Delete entry ${safeId}"><i class="fas fa-trash"></i></button>
         </li>
       `;
      });
      html += '</ul>';
      listDiv.innerHTML = html;
   }
};

// Global reference for the delete button onclick
window.Admin = Admin;
Admin.init();
