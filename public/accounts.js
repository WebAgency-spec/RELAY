
(() => {
    const stepOne = document.getElementById('account-step-one');
    const stepTwo = document.getElementById('account-step-two');
    const createPanel = document.getElementById('account-create-step');
    const loginPanel = document.getElementById('account-login-panel');
    const status = document.getElementById('account-status');
    const switchButton = document.getElementById('account-switch-button');
    const switchText = document.getElementById('account-switch-text');
    const backButton = document.getElementById('signup-back');
    const loginForm = document.getElementById('account-login-form');

    if (
        !stepOne || !stepTwo || !createPanel || !loginPanel ||
        !status || !switchButton || !backButton || !loginForm
    ) {
        console.error('Relay account forms are missing from index.html.');
        return;
    }

    let mode = 'signup';

    function showStatus(message, isError = true) {
        status.textContent = message;
        status.style.color = isError ? '#ff9a79' : '#a9e8c2';
    }

    function setBusy(form, busy, label) {
        form.querySelectorAll('button').forEach(button => {
            if (busy) {
                button.dataset.originalText = button.textContent;
                button.disabled = true;
                button.textContent = label;
            } else {
                button.disabled = false;

                if (button.dataset.originalText) {
                    button.textContent = button.dataset.originalText;
                    delete button.dataset.originalText;
                }
            }
        });
    }

    function showStep(step) {
        stepOne.hidden = step !== 1;
        stepTwo.hidden = step !== 2;
        showStatus('');

        const target = step === 2
            ? document.getElementById('signup-username')
            : document.getElementById('signup-email');

        target.focus();
    }

    function setMode(nextMode) {
        mode = nextMode;
        const signingIn = mode === 'login';

        createPanel.hidden = signingIn;
        loginPanel.hidden = !signingIn;

        switchText.textContent = signingIn
            ? 'New to Relay?'
            : 'Already have an account?';

        switchButton.textContent = signingIn
            ? 'Create account'
            : 'Sign in';

        showStatus('');

        if (signingIn) {
            document.getElementById('login-email').focus();
        } else {
            showStep(1);
        }
    }

    async function postJson(url, data) {
        const response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        let result;

        try {
            result = await response.json();
        } catch {
            throw new Error('The server returned an unexpected response.');
        }

        if (!response.ok) {
            throw new Error(result.error || 'Something went wrong.');
        }

        return result;
    }

    switchButton.addEventListener('click', () => {
        setMode(mode === 'signup' ? 'login' : 'signup');
    });

    stepOne.addEventListener('submit', event => {
        event.preventDefault();

        if (!stepOne.reportValidity()) return;

        const password = document.getElementById('signup-password');

        if (password.value.length < 8) {
            showStatus('Your password must be at least 8 characters.');
            password.focus();
            return;
        }

        showStep(2);
    });

    backButton.addEventListener('click', () => showStep(1));

    stepTwo.addEventListener('submit', async event => {
        event.preventDefault();

        if (!stepTwo.reportValidity()) return;

        const email = document.getElementById('signup-email');
        const password = document.getElementById('signup-password');
        const username = document.getElementById('signup-username');
        const chosenUsername = username.value.trim();

        if (!/^[a-zA-Z0-9_]{3,20}$/.test(chosenUsername)) {
            showStatus('Use 3–20 letters, numbers, or underscores.');
            username.focus();
            return;
        }

        setBusy(stepTwo, true, 'Creating...');
        showStatus('Creating your Relay account...', false);

        try {
            await postJson('/api/auth/register', {
                email: email.value.trim(),
                password: password.value,
                username: chosenUsername
            });

            // Registration succeeded and the server set a session cookie.
            window.location.reload();
        } catch (error) {
            showStatus(error.message);

            if (/username/i.test(error.message)) {
                username.focus();
            } else if (/email/i.test(error.message)) {
                showStep(1);
                email.focus();
            }
        } finally {
            setBusy(stepTwo, false, '');
        }
    });

    loginForm.addEventListener('submit', async event => {
        event.preventDefault();

        if (!loginForm.reportValidity()) return;

        const email = document.getElementById('login-email');
        const password = document.getElementById('login-password');

        setBusy(loginForm, true, 'Signing in...');
        showStatus('Signing you in...', false);

        try {
            await postJson('/api/auth/login', {
                email: email.value.trim(),
                password: password.value
            });

            window.location.reload();
        } catch (error) {
            showStatus(error.message);
        } finally {
            setBusy(loginForm, false, '');
        }
    });

    setMode('signup');
})();
