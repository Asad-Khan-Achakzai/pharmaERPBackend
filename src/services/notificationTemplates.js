/**
 * Central notification copy builders (lightweight template registry).
 * Domain services may call these for consistent title/body strings.
 */

function expenseSubmitted({ description, amount }) {
  return {
    title: 'Expense pending approval',
    body: `${description || 'Field expense'} — Rs ${amount}`
  };
}

function expenseApproved({ description }) {
  return {
    title: 'Expense approved',
    body: description || 'Your expense was approved'
  };
}

function expenseRejected({ reason }) {
  return {
    title: 'Expense rejected',
    body: reason || 'Your expense was rejected'
  };
}

function weeklyPlanSubmitted({ ownerName }) {
  return {
    title: 'Weekly plan pending approval',
    body: `${ownerName || 'Team member'} submitted a weekly plan for review`
  };
}

function weeklyPlanApproved() {
  return { title: 'Weekly plan approved', body: 'Your weekly plan was approved' };
}

function weeklyPlanRejected({ reason }) {
  return {
    title: 'Weekly plan needs changes',
    body: reason || 'Your weekly plan was rejected — please revise and resubmit'
  };
}

function deviceChangeRequested({ name }) {
  return {
    title: 'Device change pending',
    body: `${name || 'A team member'} requested a new device`
  };
}

function deviceChangeApproved() {
  return {
    title: 'Device change approved',
    body: 'You can sign in on the new device'
  };
}

function deviceChangeRejected({ note }) {
  return {
    title: 'Device change rejected',
    body: note || 'Your device change request was rejected'
  };
}

function doctorLocationPending({ doctorName }) {
  return {
    title: 'Doctor location to review',
    body: doctorName ? `New suggestion for ${doctorName}` : 'A doctor location suggestion needs review'
  };
}

function doctorLocationResolved({ outcome }) {
  const ok = outcome === 'approved';
  return {
    title: ok ? 'Location suggestion approved' : 'Location suggestion rejected',
    body: ok
      ? 'Your doctor location suggestion was approved'
      : 'Your doctor location suggestion was rejected'
  };
}

function orderDelivered({ label }) {
  return {
    title: 'Order delivered',
    body: label || 'An order was marked delivered'
  };
}

function orderCancelled({ label }) {
  return {
    title: 'Order cancelled',
    body: label || 'An order was cancelled'
  };
}

function planItemMissed({ doctorLabel }) {
  return {
    title: 'Missed visit',
    body: doctorLabel ? `${doctorLabel} was marked missed` : 'A planned visit was marked missed'
  };
}

module.exports = {
  expenseSubmitted,
  expenseApproved,
  expenseRejected,
  weeklyPlanSubmitted,
  weeklyPlanApproved,
  weeklyPlanRejected,
  deviceChangeRequested,
  deviceChangeApproved,
  deviceChangeRejected,
  doctorLocationPending,
  doctorLocationResolved,
  orderDelivered,
  orderCancelled,
  planItemMissed
};
